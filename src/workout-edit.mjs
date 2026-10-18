import { isDeepStrictEqual } from 'node:util';
import { PlanError } from './errors.mjs';
import { only, text, integer, boundedOutput, object } from './validate.mjs';
import { findWorkout, publicWorkout } from './workout-query.mjs';
import { normalizeEntry, normalizeSet, patchSet, hasSides } from './workout-data.mjs';
import { refreshWorkout, updateHistoryStatistics } from './workout-stats.mjs';

const KEYS = {
  add_exercise: ['type', 'exercise', 'index'], replace_exercise: ['type', 'exercise_index', 'exercise'],
  remove_exercise: ['type', 'exercise_index'], move_exercise: ['type', 'exercise_index', 'to_index'],
  add_set: ['type', 'exercise_index', 'set', 'index'], update_set: ['type', 'exercise_index', 'set_index', 'changes'],
  remove_set: ['type', 'exercise_index', 'set_index'], set_name: ['type', 'name'], set_note: ['type', 'note'],
  set_exercise_note: ['type', 'exercise_index', 'note'],
};
export function editWorkout(original, input, catalogue) {
  only(input, ['workout_id', 'actions'], 'workout edit');
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 50) throw new PlanError('actions must contain 1-50 edits');
  const current = findWorkout(original, input.workout_id);
  if (typeof current.id !== 'string' || !current.id) throw new PlanError('旧训练没有稳定 ID，请先在原 App 保存；本版不自动迁移身份', 'unsupported');
  const state = structuredClone(original);
  const workout = state.workouts.find(w => w.id === current.id);
  const operations = [];
  let metricsChanged = false;
  for (const action of input.actions) {
    object(action, 'workout action');
    if (['set_date', 'set_time', 'set_duration', 'move_date'].includes(action.type)) throw new PlanError('本版不修改训练日期、开始时间或时长；需要单独验证时区、排序和旧记录身份迁移，请使用原 App', 'unsupported');
    if (!Object.hasOwn(KEYS, action.type)) throw new PlanError('Unsupported workout edit action');
    only(action, KEYS[action.type], 'workout action');
    const structural = ['add_exercise', 'replace_exercise', 'remove_exercise', 'move_exercise'].includes(action.type);
    if (structural && workout.entries.some(e => e.sg)) throw new PlanError('含超级组的结构调整需在原 App 完成；备注和普通训练组仍可单独编辑', 'unsupported');
    let entry;
    if (KEYS[action.type].includes('exercise_index')) entry = workout.entries[integer(action.exercise_index, 0, workout.entries.length - 1, 'exercise_index')];
    switch (action.type) {
      case 'set_name': workout.name = text(action.name, 60, 'name'); break;
      case 'set_note': workout.note = text(action.note, 500, 'note', { empty: true }); break;
      case 'set_exercise_note': entry.note = text(action.note, 500, 'exercise.note', { empty: true }); break;
      case 'add_exercise': {
        const added = normalizeEntry(action.exercise, { state, catalogue });
        const index = action.index === undefined ? workout.entries.length : integer(action.index, 0, workout.entries.length, 'index');
        workout.entries.splice(index, 0, added); metricsChanged = true; break;
      }
      case 'replace_exercise': {
        const replacement = normalizeEntry(action.exercise, { state, catalogue });
        if (replacement.id === entry.id) replacement.sets = replacement.sets.map((row,index)=>{
          const previous=entry.sets[index];
          if (!previous) return row;
          const merged={...structuredClone(previous),...row};
          for (const key of ['w','r','sec','min','km','dist','speed','rir','rpe','planSec','sides','side','type','drops','clusters','weightOrigin','at']) if (!(key in row)) delete merged[key];
          return merged;
        });
        const target = { ...entry.target };
        // A replacement's prescription belongs to its new exercise. Unknown target
        // extensions, occurrence notes/media and routine provenance remain opaque.
        for (const k of ['id', 'mode', 'side', 'sets', 'reps', 'sec', 'min', 'speed', 'weight', 'dbLoad', 'bodyweight']) delete target[k];
        Object.assign(target, replacement.target || {});
        const replaced = { ...entry, ...replacement, target };
        if (action.exercise.note === undefined && entry.note !== undefined) replaced.note = entry.note;
        if (replacement.id !== entry.id) delete replaced.muscleSnapshot;
        workout.entries[action.exercise_index] = replaced; metricsChanged = true; break;
      }
      case 'remove_exercise':
        if (workout.entries.length <= 1) throw new PlanError('不能把训练清空；本版不删除整次训练');
        workout.entries.splice(action.exercise_index, 1); metricsChanged = true; break;
      case 'move_exercise': {
        const destination = integer(action.to_index, 0, workout.entries.length - 1, 'to_index');
        workout.entries.splice(action.exercise_index, 1); workout.entries.splice(destination, 0, entry); break;
      }
      case 'add_set': {
        if (entry.sets.length >= 30) throw new PlanError('每个动作最多 30 组');
        const index = action.index === undefined ? entry.sets.length : integer(action.index, 0, entry.sets.length, 'index');
        const row = normalizeSet(action.set);
        entry.sets.splice(index, 0, row);
        if ((hasSides(row) || row.side) && !entry.target?.side && entry.target?.dbLoad === 'each') throw new PlanError('不能改变既有双侧哑铃动作的容量口径；请新增独立单侧动作项', 'unsupported');
        if (hasSides(row) || row.side) entry.target = { ...entry.target, side: true };
        metricsChanged = true; break;
      }
      case 'update_set': {
        const index = integer(action.set_index, 0, entry.sets.length - 1, 'set_index');
        entry.sets[index] = patchSet(entry.sets[index], action.changes); metricsChanged = true; break;
      }
      case 'remove_set':
        if (entry.sets.length <= 1) throw new PlanError('不能移除动作的最后一组，请明确移除整个动作');
        entry.sets.splice(integer(action.set_index, 0, entry.sets.length - 1, 'set_index'), 1); metricsChanged = true; break;
    }
    operations.push({ type: action.type, ...(action.exercise_index === undefined ? {} : { exercise_index: action.exercise_index }),
      ...(action.set_index === undefined ? {} : { set_index: action.set_index }) });
  }
  if (workout.entries.length > 30) throw new PlanError('每次训练最多 30 个动作');
  if (!workout.entries.some(e => e.sets.some(s => s.done || (hasSides(s) && (s.sides.L.done || s.sides.R.done))))) throw new PlanError('修改后没有已完成训练组；本版不清空训练');
  let statistics = [];
  // Do not canonicalize unchanged or note-only records: that would invent an edit
  // to fields the user never asked to touch, particularly legacy target/weight data.
  const changed = !isDeepStrictEqual(current, workout);
  if (changed && metricsChanged) {
    refreshWorkout(workout, state, catalogue);
    statistics = updateHistoryStatistics(state, { before: current, editedId: workout.id,
      affectedIds: [...current.entries, ...workout.entries].map(e => e.id), catalogue });
  }
  const saved = state.workouts.find(w => w.id === current.id);
  return { state, details: boundedOutput({ workout_id: current.id, before: publicWorkout(current, original, catalogue),
    after: publicWorkout(saved, state, catalogue), operations, statistics_changes: statistics,
    media_and_unknown_fields_preserved: true, date_and_time_unchanged: true,
    replacement_updates_exercise_target: input.actions.some(a => a.type === 'replace_exercise'),
    replacement_discards_only_stale_muscle_snapshot: input.actions.some(a => a.type === 'replace_exercise') }),
    result: { workout_id: current.id, records: [{ workout_id: current.id }], changes: operations } };
}
