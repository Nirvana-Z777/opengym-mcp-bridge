import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, catalogue, fixture } from './fixtures.mjs';
import { normalizeEntry, workoutVolume } from '../src/workout-data.mjs';

// All measurements and records here are deliberately fictional.
const bilateral = { weight: 3, reps: 4 };
const unilateral = { sides: { L: { weight: 2, reps: 3 }, R: { weight: 1, reps: 2 } } };
const session = exercises => ({ workouts: [{ date: '2000-02-03', name: 'Synthetic validation session', exercises }] });
const exercise = (sets, weight_basis) => ({ exercise_id: 'a', sets, ...(weight_basis ? { weight_basis } : {}) });
async function rejectedBeforeWrite(context, preview, code) {
  const before = structuredClone(context.client.data);
  const reason = code === 'unsupported' ? /per_dumbbell/ : /已完成组/;
  await assert.rejects(preview, error => error.code === code && reason.test(error.message));
  assert.equal(context.backups.length, 0, 'A rejected preview must never create a backup');
  assert.equal(context.client.puts.length, 0, 'A rejected preview must never submit a PUT');
  assert.equal(context.bridge.writer.proposals.size, 0, 'A rejected preview must not issue a proposal');
  assert.deepEqual(context.client.data, before, 'A rejected preview must not mutate the snapshot');
}

test('Log previews reject mixed bilateral/unilateral per-bell entries, irrespective of row order or completion', async () => {
  for (const sets of [[bilateral, unilateral], [unilateral, bilateral],
    [{ ...bilateral, phase: 'warmup' }, unilateral], [{ ...bilateral, done: false }, unilateral],
    [bilateral, { weight: 2, seconds: 15, side: 'L' }]]) {
    const context = setup();
    context.client.data.workouts = []; context.client.data.exWeights = {};
    await rejectedBeforeWrite(context, () => context.bridge.previewWorkoutLog(session([exercise(sets, 'per_dumbbell')])), 'unsupported');
  }
});

test('Add/replace exercise previews reject ambiguous per-bell rows before backup or PUT', async () => {
  for (const type of ['add_exercise', 'replace_exercise']) {
    const context = setup();
    context.client.data.workouts[0].entries[0].target.dbLoad = 'each';
    const action = { type, exercise: exercise([bilateral, unilateral], 'per_dumbbell'), ...(type === 'replace_exercise' ? { exercise_index: 0 } : {}) };
    await rejectedBeforeWrite(context, () => context.bridge.previewWorkoutEdit({ workout_id: 'w1', actions: [action] }), 'unsupported');
  }
});

test('Adding either layout to the opposite per-bell layout is rejected during edit preview', async () => {
  for (const [original, added] of [[bilateral, unilateral], [unilateral, bilateral]]) {
    const context = setup();
    context.client.data.workouts[0].entries[0] = normalizeEntry(exercise([original], 'per_dumbbell'), { state: context.client.data, catalogue });
    await rejectedBeforeWrite(context, () => context.bridge.previewWorkoutEdit({ workout_id: 'w1', actions: [{ type: 'add_set', exercise_index: 0, set: added }] }), 'unsupported');
  }
});

test('Volume calculation refuses existing mixed per-bell rows with either entry side flag', () => {
  const state = fixture();
  for (const side of [true, false]) {
    const entry = { id: 'a', target: { dbLoad: 'each', side }, sets: [
      { w: 3, r: 4, done: true },
      { w: 2, r: 5, done: true, sides: { L: { w: 2, r: 3, done: true }, R: { w: 1, r: 2, done: true } } },
    ] };
    assert.throws(() => workoutVolume({ entries: [entry] }, state, catalogue), error => error.code === 'unsupported' && /per_dumbbell/.test(error.message));
  }
});

const incompleteSets = [
  [{ weight: 3, reps: 4, done: false }],
  [{ seconds: 15, done: false }],
  [{ sides: { L: { weight: 2, reps: 3, done: false }, R: { weight: 1, reps: 2, done: false } } }],
];
test('Log previews reject each all-incomplete exercise even when another exercise is completed', async () => {
  for (const sets of incompleteSets) for (const withCompleted of [false, true]) {
    const context = setup();
    const exercises = [exercise(sets), ...(withCompleted ? [{ exercise_id: 't', sets: [{ seconds: 20 }] }] : [])];
    await rejectedBeforeWrite(context, () => context.bridge.previewWorkoutLog(session(exercises)), 'validation');
  }
});

test('Add/replace exercise previews reject all-incomplete reps, timed rows and unilateral limbs', async () => {
  for (const type of ['add_exercise', 'replace_exercise']) for (const sets of incompleteSets) {
    const context = setup();
    context.client.data.workouts[0].entries.push({ id: 't', sets: [{ mode: 'time', sec: 20, done: true }] });
    const action = { type, exercise: exercise(sets), ...(type === 'replace_exercise' ? { exercise_index: 0 } : {}) };
    await rejectedBeforeWrite(context, () => context.bridge.previewWorkoutEdit({ workout_id: 'w1', actions: [action] }), 'validation');
  }
});

test('An edit cannot leave an exercise without completed sets behind another completed exercise', async () => {
  const context = setup();
  context.client.data.workouts[0].entries.push({ id: 't', sets: [{ mode: 'time', sec: 20, done: true }] });
  await rejectedBeforeWrite(context, () => context.bridge.previewWorkoutEdit({ workout_id: 'w1', actions: [
    { type: 'update_set', exercise_index: 0, set_index: 0, changes: { done: false } },
  ] }), 'validation');
});

test('Completed entries retain unchecked sets and a single completed limb is sufficient', async () => {
  for (const sets of [[{ ...bilateral, done: true }, { ...bilateral, done: false }],
    [{ seconds: 15, done: true }, { seconds: 20, done: false }],
    [{ sides: { L: { weight: 2, reps: 3, done: true }, R: { weight: 1, reps: 2, done: false } } }]]) {
    const context = setup();
    const preview = await context.bridge.previewWorkoutLog(session([exercise(sets)]));
    assert.ok(preview.proposal_id);
    const rows = preview.records[0].exercises[0].sets;
    if (sets[0].sides) { assert.equal(rows[0].done, false); assert.equal(rows[0].sides.L.done, true); assert.equal(rows[0].sides.R.done, false); }
    else { assert.equal(rows.length, 2); assert.equal(rows[1].done, false); }
    assert.equal(context.backups.length, 0); assert.equal(context.client.puts.length, 0);
  }
});

test('Unambiguous separate per-bell occurrences keep their own volume factors', async () => {
  const { bridge, client, backups } = setup(); client.data.workouts = []; client.data.exWeights = {};
  const preview = await bridge.previewWorkoutLog(session([exercise([bilateral], 'per_dumbbell'), exercise([unilateral], 'per_dumbbell')]));
  assert.equal(preview.records[0].volume, 32); // 3*4*2 + 2*3 + 1*2, with no numeric conversion.
  assert.equal(preview.records[0].exercises[0].sets[0].weight, 3);
  assert.equal(preview.records[0].exercises[1].sets[0].sides.L.weight, 2);
  assert.equal(backups.length, 0); assert.equal(client.puts.length, 0);
});

test('As-recorded and pair-total mixed entries retain their existing count-once meaning', async () => {
  for (const basis of ['as_recorded', 'pair_total']) {
    const { bridge, client, backups } = setup(); client.data.workouts = []; client.data.exWeights = {};
    const preview = await bridge.previewWorkoutLog(session([exercise([bilateral, unilateral], basis)]));
    assert.equal(preview.records[0].volume, 20);
    assert.equal(backups.length, 0); assert.equal(client.puts.length, 0);
  }
});
