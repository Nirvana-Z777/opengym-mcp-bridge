import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileBackupStore } from '../src/backup.mjs';
import { fetchCatalogue, loadExerciseCatalogue } from '../src/catalogue.mjs';
import { dispatch } from '../src/mcp.mjs';
import { setup, approve, catalogue, customCreate, logInput } from './fixtures.mjs';

const planInput = { actions: [{ type: 'assign_weekday', weekday: 2, routine_id: 'r' }] };
const bodyInput = { items: [{ kind: 'weight', date: '2000-02-01', time: '08:00', value: 61, unit: 'kg' }] };
const stale = error => ['expired', 'conflict'].includes(error.code);
const coded = code => error => error.code === code;

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'bridge-v051-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'catalogue.json');
  const localDirectory = path.join(directory, 'local');
  const backupDirectory = path.join(directory, 'account-backups');
  const previous = { ...structuredClone(catalogue), source_version: '1.4.2', source_commit: 'synthetic-old' };
  previous.exercises.a.muscleWeights = { chest: 0.25 };
  const oldBytes = Buffer.from(JSON.stringify(previous, null, 2) + '\n');
  await fs.writeFile(file, oldBytes);
  const candidate = { ...structuredClone(previous), source_version: '1.4.5', source_commit: 'synthetic-new' };
  candidate.exercises.a.muscleWeights = { chest: 1 };
  candidate.names.b = 'Updated synthetic row';
  const h = {
    directory, file, localDirectory, backupDirectory, oldBytes, candidate,
    fetch: async () => structuredClone(candidate),
    ...setup({
      catalogueFile: file, localDirectory, loadCatalogue: () => loadExerciseCatalogue(file),
      fetchCatalogue: () => h.fetch(), backup: new FileBackupStore({ directory: backupDirectory }),
    }),
  };
  h.client.baseUrl = 'https://synthetic.invalid';
  let logins = 0;
  h.client.refreshLogin = async () => {
    logins++;
    return { user: { id: 'synthetic-v051' } };
  };
  h.logins = () => logins;
  h.call = async (name, args = {}) => {
    const reply = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, h.bridge);
    assert.equal(reply.error, undefined);
    if (reply.result.isError) {
      const { code, error } = JSON.parse(reply.result.content[0].text);
      throw Object.assign(new Error(error), { code });
    }
    return reply.result.structuredContent;
  };
  return h;
}

async function makeDraft(h) {
  const draft = await h.call('start_workout_draft', { date: '2000-02-02', name: 'Synthetic draft' });
  const ref = { draft_id: draft.draft_id, expected_revision: draft.revision };
  const withExercise = await h.call('draft_add_exercise', { ...ref, exercise_id: 'b' });
  return h.call('draft_add_set', { ...ref, expected_revision: withExercise.revision, exercise_index: 0, set: { weight: 2, reps: 3 } });
}

const previewRefresh = h => h.call('preview_catalogue_refresh');
const applyRefresh = (h, proposal) => h.call('apply_catalogue_refresh', approve(proposal));
async function refresh(h) {
  const preview = await previewRefresh(h);
  assert.equal(preview.changed, true);
  return applyRefresh(h, preview);
}

async function assertNoAccountWrite(h) {
  assert.deepEqual(h.client.puts, []);
  await assert.rejects(() => fs.stat(h.backupDirectory), { code: 'ENOENT' });
}

const writePaths = [
  ['preview_plan_change', 'apply_plan_change', () => planInput],
  ['preview_workout_log', 'log_workout', () => logInput],
  ['preview_custom_exercise_change', 'apply_custom_exercise_change', () => ({ actions: [customCreate] })],
  ['preview_workout_edit', 'apply_workout_edit', () => ({ workout_id: 'w1', actions: [{ type: 'set_note', note: 'New synthetic note' }] })],
  ['preview_finish_workout_draft', 'commit_finished_workout_draft', async h => ({ draft_id: (await makeDraft(h)).draft_id })],
  ['preview_body_sync', 'apply_body_sync', () => bodyInput],
];

for (const [previewTool, applyTool, inputFor] of writePaths) {
  test(`${previewTool}: refresh expires old preview before backup or PUT, and a fresh preview verifies`, async t => {
    const h = await harness(t);
    const input = await inputFor(h);
    const before = structuredClone(h.client.data);
    const old = await h.call(previewTool, input);
    assert.ok(old.proposal_id);
    const updated = await refresh(h);
    assert.equal(updated.catalogue.version, '1.4.5');
    assert.deepEqual(await fs.readFile(path.join(h.directory, updated.backup)), h.oldBytes);
    assert.equal(h.bridge.writer.proposals.size, 0);
    await assert.rejects(() => h.call(applyTool, approve(old)), stale);
    await assertNoAccountWrite(h);
    assert.deepEqual(h.client.data, before);
    if (input.draft_id) assert.equal((await h.call('get_workout_draft', input)).status, 'open');

    const fresh = await h.call(previewTool, input);
    assert.ok(fresh.proposal_id && fresh.proposal_id !== old.proposal_id);
    const result = await h.call(applyTool, approve(fresh));
    assert.equal(result.status, 'verified');
    assert.equal(result.verified, true);
    assert.equal(h.client.puts.length, 1);
    assert.equal(h.client.puts[0].baseRev, before._rev);
    assert.equal(h.client.puts[0].baseWid, before._wid);
    const files = await fs.readdir(h.backupDirectory);
    assert.deepEqual(files, [result.backup.id]);
    const backup = JSON.parse(await fs.readFile(path.join(h.backupDirectory, files[0])));
    assert.deepEqual(backup.state, before);
  });
}

const officialFile = 'frontend/src/lib/exercises-data.js';
const failFs = (t, method, matches) => {
  const original = fs[method];
  const mock = t.mock.method(fs, method, async (...args) => {
    if (matches(args)) throw Object.assign(new Error('Synthetic file operation failure'), { code: 'EACCES' });
    return original(...args);
  });
  return () => mock.mock.restore();
};
const failures = [
  ['download failure', h => { h.fetch = () => fetchCatalogue({ fetchImpl: async () => new Response('', { status: 503 }) }); }, /HTTP 503/],
  ['official SHA-256 mismatch', h => { h.fetch = () => fetchCatalogue({ fetchImpl: async () => new Response('synthetic unexpected bytes') }); }, /固定文件摘要不匹配/],
  ['invalid official JSON structure', h => {
    const text = 'export const EXDB=JSON.parse(\'{}\');';
    const digests = { [officialFile]: createHash('sha256').update(text).digest('hex') };
    h.fetch = () => fetchCatalogue({ digests, fetchImpl: async () => new Response(text) });
  }, /EXDB content count/],
  ['changed on-disk catalogue', async h => {
    await fs.appendFile(h.file, ' ');
  }, coded('conflict')],
  ['catalogue backup failure', (h, t) => failFs(t, 'open', ([file]) => file.endsWith('.bak')), coded('backup-failed')],
  ['atomic replacement failure', (h, t) => failFs(t, 'rename', ([, destination]) => destination === h.file), coded('catalogue-replace-failed')],
  ['filesystem lock contention', async h => { await fs.mkdir(h.file + '.refresh-lock'); }, coded('busy')],
];

for (const [label, arrange, expected] of failures) {
  test(`Refresh ${label}: local bytes, account state, and prior preview remain intact`, async t => {
    const h = await harness(t);
    const old = await h.call('preview_plan_change', planInput);
    const preview = await previewRefresh(h);
    const restore = await arrange(h, t);
    const before = structuredClone(h.client.data);
    const bytes = await fs.readFile(h.file);
    try { await assert.rejects(() => applyRefresh(h, preview), expected); }
    finally { if (restore) restore(); }
    assert.deepEqual(await fs.readFile(h.file), bytes);
    assert.deepEqual(h.client.data, before);
    await assertNoAccountWrite(h);
    if (label !== 'filesystem lock contention')
      assert.equal((await fs.readdir(h.directory)).some(file => file.endsWith('.refresh-lock') || file.endsWith('.tmp')), false);
    assert.equal((await h.call('apply_plan_change', approve(old))).verified, true);
  });
}

test('A no-op refresh keeps existing account proposals valid', async t => {
  const h = await harness(t);
  const old = await h.call('preview_plan_change', planInput);
  h.fetch = async () => JSON.parse(h.oldBytes);
  const noChange = await previewRefresh(h);
  assert.equal(noChange.changed, false);
  assert.equal(noChange.proposal_id, null);
  await assertNoAccountWrite(h);
  assert.equal((await h.call('apply_plan_change', approve(old))).verified, true);
});

function pause(t) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(release.resolve);
  return { entered: entered.promise, resume: release.resolve, wait: () => { entered.resolve(); return release.promise; } };
}

test('A running refresh blocks account commits and another refresh; a preview produced meanwhile expires', async t => {
  const h = await harness(t);
  const old = await h.call('preview_plan_change', planInput);
  const proposal = await previewRefresh(h);
  const gate = pause(t);
  h.fetch = async () => { await gate.wait(); return h.candidate; };
  const pending = applyRefresh(h, proposal);
  try {
    await gate.entered;
    await assert.rejects(() => h.call('apply_plan_change', approve(old)), coded('busy'));
    await assert.rejects(() => applyRefresh(h, proposal), coded('busy'));
    const during = await h.call('preview_plan_change', planInput);
    assert.ok(during.proposal_id);
    await assert.rejects(() => h.call('apply_plan_change', approve(during)), coded('busy'));
    assert.deepEqual(await fs.readFile(h.file), h.oldBytes);
    gate.resume();
    assert.equal((await pending).applied, true);
    await assert.rejects(() => h.call('apply_plan_change', approve(old)), stale);
    await assert.rejects(() => h.call('apply_plan_change', approve(during)), stale);
    await assertNoAccountWrite(h);
  } finally { gate.resume(); await pending; }
});

test('An openGym write holds the lock through post-PUT reread and prevents catalogue replacement', async t => {
  const h = await harness(t);
  const old = await h.call('preview_plan_change', planInput);
  const proposal = await previewRefresh(h);
  const gate = pause(t);
  const read = h.client.getData.bind(h.client);
  h.client.getData = async () => {
    if (h.client.puts.length) await gate.wait();
    return read();
  };
  const writing = h.call('apply_plan_change', approve(old));
  try {
    await gate.entered;
    await assert.rejects(() => applyRefresh(h, proposal), coded('busy'));
    assert.deepEqual(await fs.readFile(h.file), h.oldBytes);
  } finally { gate.resume(); await writing; }
  assert.equal((await writing).verified, true);
  assert.equal((await applyRefresh(h, proposal)).applied, true);
  assert.equal(h.client.puts.length, 1);
});

test('Old catalogue loaded before refresh cannot register a proposal after the refresh', async t => {
  const h = await harness(t);
  const gate = pause(t);
  h.bridge.loadCatalogue = async () => {
    const old = await loadExerciseCatalogue(h.file);
    assert.equal(old.source_version, '1.4.2');
    await gate.wait();
    return old;
  };
  const computing = h.call('preview_plan_change', planInput);
  const rejected = assert.rejects(computing, stale);
  try {
    await gate.entered;
    assert.equal((await refresh(h)).applied, true);
  } finally { gate.resume(); await rejected; }
  assert.equal(h.bridge.writer.proposals.size, 0);
  await assertNoAccountWrite(h);
});

test('Catalogue replacement rechecks on-disk bytes after its backup and retains a concurrent change', async t => {
  const h = await harness(t);
  const old = await h.call('preview_plan_change', planInput);
  const preview = await previewRefresh(h);
  const gate = pause(t);
  const chmod = fs.chmod;
  const mock = t.mock.method(fs, 'chmod', async (target, mode) => {
    if (target.startsWith(h.file + '.') && target.endsWith('.tmp')) await gate.wait();
    return chmod(target, mode);
  });
  const pending = applyRefresh(h, preview);
  const rejected = assert.rejects(pending, coded('conflict'));
  let changed;
  try {
    await gate.entered;
    await fs.appendFile(h.file, '\n');
    changed = await fs.readFile(h.file);
  } finally { gate.resume(); await rejected; mock.mock.restore(); }
  assert.deepEqual(await fs.readFile(h.file), changed);
  await assertNoAccountWrite(h);
  assert.equal((await h.call('apply_plan_change', approve(old))).verified, true);
});

test('A successful rename expires proposals even if releasing the filesystem lock fails', async t => {
  const h = await harness(t);
  const old = await h.call('preview_plan_change', planInput);
  const restore = failFs(t, 'rmdir', ([file]) => file === h.file + '.refresh-lock');
  let result;
  try { result = await refresh(h); }
  finally { restore(); }
  assert.equal(result.applied, true);
  assert.match(result.warning, /lock could not be removed/);
  assert.deepEqual(JSON.parse(await fs.readFile(h.file)), h.candidate);
  await assert.rejects(() => h.call('apply_plan_change', approve(old)), stale);
  await assertNoAccountWrite(h);
});

async function directoryBytes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(root, file), await fs.readFile(file)];
  })));
}

test('Refresh preserves drafts, questionnaire, exercise/body feedback, credentials and all upstream records', async t => {
  const h = await harness(t);
  const draft = await makeDraft(h);
  await h.call('record_session_feedback', { draft_id: draft.draft_id, questionnaire: { sleep: 4 } });
  await h.call('record_session_feedback', { draft_id: draft.draft_id, exercise_feedback: { exercise_index: 0, discomfort: 'none' } });
  await h.call('record_body_feedback', { date: '2000-02-01', body_weight: 60, unit: 'kg', feedback: 'Synthetic' });
  h.client.data.bodyweight = [{ d: '2000-01-01', w: 60 }];
  h.client.data.measurements = [{ d: '2000-01-01', waist: 72 }];
  const secrets = path.join(h.directory, 'secrets');
  await fs.mkdir(secrets);
  await fs.writeFile(path.join(secrets, 'opengym-token.json'), '{"token":"synthetic-test-only"}');
  await fs.writeFile(path.join(secrets, 'mcp-access-token'), 'synthetic-test-only');
  const privateBefore = await directoryBytes(h.localDirectory);
  assert.equal(Object.keys(privateBefore).length, 4);
  const secretsBefore = await directoryBytes(secrets);
  const before = structuredClone(h.client.data);
  const reads = h.client.reads;
  const logins = h.logins();
  await refresh(h);
  assert.deepEqual(await directoryBytes(h.localDirectory), privateBefore);
  assert.deepEqual(await directoryBytes(secrets), secretsBefore);
  assert.deepEqual(h.client.data, before);
  assert.equal(h.client.reads, reads);
  assert.equal(h.logins(), logins);
  await assertNoAccountWrite(h);
});

test('Updated weights apply only without a historical snapshot; effective_sets tracks both sources', async t => {
  const h = await harness(t);
  const workout = h.client.data.workouts[0];
  workout.entries[0].muscleSnapshot.muscleWeights = { chest: 0.5, triceps: 0.75 };
  const fallback = structuredClone(workout.entries[0]);
  delete fallback.muscleSnapshot;
  workout.entries.push(fallback);
  const original = structuredClone(h.client.data);
  const stats = () => h.call('get_weekly_training_summary', { from: '1999-12-27', to: '2000-01-02' });
  const before = await stats();
  assert.equal(before.weeks[0].muscles.chest.effective_sets, 0.75);
  await refresh(h);
  const { current } = await h.call('get_catalogue_status');
  assert.equal(current.version, '1.4.5');
  assert.equal(current.commit, 'synthetic-new');
  const after = await stats();
  assert.equal(after.muscle_weight_catalogue.version, '1.4.5');
  assert.equal(after.weeks[0].muscles.chest.effective_sets, 1.5);
  assert.equal(after.weeks[0].muscles.triceps.effective_sets, 0.75);
  assert.deepEqual(after.weeks[0].muscle_weight_sources, { snapshot_explicit: 1, catalogue_explicit: 1 });
  assert.deepEqual(h.client.data, original);
  await assertNoAccountWrite(h);
});
