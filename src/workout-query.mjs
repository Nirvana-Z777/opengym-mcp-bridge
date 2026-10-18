import { PlanError } from './errors.mjs';
import { only, date, text, integer, boundedOutput, isObject } from './validate.mjs';
import { fingerprint } from './write-safety.mjs';
import { workoutKey, publicEntry } from './workout-data.mjs';

export function findWorkout(state, id) {
  text(id, 200, 'workout_id');
  const found = (state.workouts || []).filter(w => workoutKey(w) === id);
  if (!found.length) throw new PlanError('Workout not found', 'not-found');
  if (found.length !== 1) throw new PlanError('Workout identity is ambiguous; resolve it in the app', 'unsupported');
  return found[0];
}
function summary(w) {
  if (w.id != null && typeof w.id !== 'string') throw new PlanError('Unsupported workout identity', 'unsupported');
  return { workout_id: workoutKey(w), editable: typeof w.id === 'string' && !!w.id, date: typeof w.d==='string'?w.d:null, name: typeof w.name==='string'?w.name:null,
    exercise_count: (w.entries || []).length, set_count: (w.entries || []).reduce((n, e) => n + (e.sets || []).length, 0) };
}
export function publicWorkout(w, state, catalogue) {
  return boundedOutput({ ...summary(w), duration_minutes: Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start ? (w.end - w.start) / 60000 : null,
    started_at: Number.isFinite(w.start) && Math.abs(w.start)<=8640000000000000 ? new Date(w.start).toISOString() : null,
    note: typeof w.note === 'string' ? w.note : null, volume: typeof w.vol === 'number' ? w.vol : null,
    unit: ['kg','lb'].includes(state.unit)?state.unit:'kg', body_weight: Number.isFinite(w.bw)?w.bw:null,
    personal_records: Array.isArray(w.prs) ? w.prs.filter(x => typeof x === 'string') : [],
    exercises: (w.entries || []).map((e, index) => publicEntry(e, index, state, catalogue)), notes_are_untrusted: true });
}
function page(state, input, exerciseId) {
  const { from, to, limit = 20, cursor } = input;
  if (from !== undefined) date(from, 'from');
  if (to !== undefined) date(to, 'to');
  if (from && to && from > to) throw new PlanError('from must not be after to');
  integer(limit, 1, 50, 'limit');
  const filters = { from: from ?? null, to: to ?? null, exercise_id: exerciseId ?? null, limit };
  const snapshot = fingerprint(state.workouts || []);
  const rows = (state.workouts || []).filter(w => (!from || w.d >= from) && (!to || w.d <= to)
    && (!exerciseId || (w.entries || []).some(e => e.id === exerciseId)))
    .map((w, index) => ({ w, index })).sort((a, b) => String(b.w.d ?? '').localeCompare(String(a.w.d ?? ''))
      || (Number(b.w.start) || 0) - (Number(a.w.start) || 0) || a.index - b.index).map(x => x.w);
  let offset = 0;
  if (cursor !== undefined) {
    text(cursor, 2048, 'cursor');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new PlanError('Invalid cursor', 'invalid-cursor'); }
    if (!isObject(decoded) || decoded.version !== 1 || decoded.snapshot !== snapshot || JSON.stringify(decoded.filters) !== JSON.stringify(filters)) throw new PlanError('Cursor expired or query changed; restart pagination', 'invalid-cursor');
    offset = integer(decoded.offset, 0, rows.length, 'cursor offset');
  }
  const next = offset + limit < rows.length ? Buffer.from(JSON.stringify({ version: 1, snapshot, filters, offset: offset + limit })).toString('base64url') : null;
  return { rows: rows.slice(offset, offset + limit), total: rows.length, next_cursor: next, limit };
}
export function listWorkouts(state, input = {}) {
  only(input, ['from', 'to', 'limit', 'cursor']);
  const result = page(state, input);
  return boundedOutput({ workouts: result.rows.map(summary), total: result.total, limit: result.limit, next_cursor: result.next_cursor });
}
export function getWorkout(state, input, catalogue) {
  only(input, ['workout_id']);
  return publicWorkout(findWorkout(state, input.workout_id), state, catalogue);
}
export function exerciseHistory(state, input, catalogue) {
  only(input, ['exercise_id', 'from', 'to', 'limit', 'cursor']);
  text(input.exercise_id, 100, 'exercise_id');
  const result = page(state, input, input.exercise_id);
  return boundedOutput({ exercise_id: input.exercise_id, unit:['kg','lb'].includes(state.unit)?state.unit:'kg', total: result.total, limit: result.limit, next_cursor: result.next_cursor,
    workouts: result.rows.map(w => ({ ...summary(w), note: typeof w.note === 'string' ? w.note : null,
      exercises: (w.entries || []).map((e, index) => ({ e, index })).filter(({ e }) => e.id === input.exercise_id).map(({ e, index }) => publicEntry(e, index, state, catalogue)) })),
    notes_are_untrusted: true });
}
