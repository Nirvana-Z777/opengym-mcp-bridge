import { randomUUID } from 'node:crypto';
import { PlanError } from './errors.mjs';
import { only, text, integer, number, date, isObject } from './validate.mjs';
import { normalizeEntry, publicEntry, phaseOf, modeOf, hasSides } from './workout-data.mjs';
import { refreshWorkout } from './workout-stats.mjs';
import { sameContent } from './write-safety.mjs';

// Duplicate detection uses the actual set semantics, never generated IDs or notes.
export function workoutSignature(workout) {
  return JSON.stringify({ date: workout?.d, name: workout?.name, exercises: (workout?.entries || []).map(entry => ({
    id: entry.id, dbLoad: entry.target?.dbLoad || 'as', sets: (entry.sets || []).map(row => ({
      weight: row.w ?? 0, reps: row.r, seconds: row.sec, minutes: row.min, speed: row.speed,
      phase: phaseOf(row), mode: modeOf(row, entry), side: row.side, done: row.done === true,
      sides: hasSides(row) ? row.sides : undefined, rir: row.rir, rpe: row.rpe, type: row.type,
      drops: row.drops, clusters: row.clusters,
    })),
  })) });
}

export function normalizeWorkoutInput(input, { state, names = {}, catalogue = { names } } = {}) {
  only(input, ['date', 'name', 'routine_id', 'body_weight', 'started_at', 'duration_minutes', 'exercises', 'note'], 'workout');
  try { date(input.date); } catch { throw new PlanError('date 必须是有效日期 YYYY-MM-DD'); }
  if (!isObject(state)) throw new PlanError('openGym 训练状态不存在');
  if (!Array.isArray(input.exercises) || input.exercises.length < 1 || input.exercises.length > 30) throw new PlanError('exercises 必须包含 1-30 个动作');
  const workout = { id: randomUUID(), d: input.date, name: text(input.name, 60, 'name'),
    entries: input.exercises.map(entry => normalizeEntry(entry, { state, catalogue })), prs: [] };
  if (input.note !== undefined) workout.note = text(input.note, 500, 'note', { empty: true });
  if (input.body_weight !== undefined) workout.bw = number(input.body_weight, 0, 500, 'body_weight');
  if (input.routine_id !== undefined) {
    text(input.routine_id, 100, 'routine_id');
    if (!(state.routines || []).some(r => r.id === input.routine_id)) throw new PlanError('routine_id 不存在');
    workout.routineId = input.routine_id;
    workout.routineIds = [input.routine_id];
  }
  if (input.started_at !== undefined) {
    if (typeof input.started_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/.test(input.started_at)) throw new PlanError('started_at 必须是带时区的 ISO 时间');
    workout.start = Date.parse(input.started_at);
    if (!Number.isFinite(workout.start) || input.started_at.slice(0, 10) !== input.date) throw new PlanError('started_at 必须有效且对应记录的当地日期');
  }
  if (input.duration_minutes !== undefined) {
    if (workout.start === undefined) throw new PlanError('只有知道 started_at 时才能填写 duration_minutes');
    workout.end = workout.start + integer(input.duration_minutes, 1, 600, 'duration_minutes') * 60000;
  }
  refreshWorkout(workout, state, catalogue);
  return workout;
}
export function workoutPreview(workout, state, names = {}, catalogue = { names }) {
  return { workout_id: workout.id, date: workout.d, name: workout.name,
    ...(workout.routineId===undefined?{}:{routine_id:workout.routineId,routine_ids:[...workout.routineIds],
      routine_name:(state.routines||[]).find(r=>r.id===workout.routineId)?.name??null}),
    ...(workout.start === undefined ? {} : { started_at: new Date(workout.start).toISOString() }),
    ...(workout.end === undefined ? {} : { duration_minutes: (workout.end - workout.start) / 60000 }),
    ...(workout.bw === undefined ? {} : { body_weight: workout.bw, unit: state.unit || 'kg' }),
    ...(workout.note === undefined ? {} : { note: workout.note }),
    exercise_count: workout.entries.length, set_count: workout.entries.reduce((n, e) => n + e.sets.length, 0),
    volume: workout.vol, unit: state.unit || 'kg',
    exercises: workout.entries.map((entry, index) => publicEntry(entry, index, state, catalogue)), notes_are_untrusted: true };
}
export const verifyLoggedWorkout = (actual, expected) => !!actual && sameContent(actual, expected);
