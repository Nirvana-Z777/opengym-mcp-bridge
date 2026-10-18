import { isDeepStrictEqual } from 'node:util';
import { PlanError } from './errors.mjs';
import { date } from './validate.mjs';
import { assisted, beats, bestLoad, exerciseMetadata, basisOf, workoutVolume } from './workout-data.mjs';

function bestIn(workout, id, state, catalogue) {
  let best = 0;
  for (const entry of workout?.entries || []) if (entry.id === id) {
    const load = bestLoad(entry, state, catalogue);
    if (beats(load, best, assisted(state, catalogue, entry))) best = load;
  }
  return best;
}
export function insertHistory(workouts, records) {
  const out = [...workouts];
  for (const record of [...records].sort((a, b) => a.d.localeCompare(b.d) || (a.start ?? 0) - (b.start ?? 0))) {
    const at = out.findIndex(w => typeof w.d === 'string' && (w.d > record.d || (w.d === record.d && Number.isFinite(w.start) && Number.isFinite(record.start) && w.start > record.start)));
    if (at < 0) out.push(record); else out.splice(at, 0, record);
  }
  return out;
}
export function updateHistoryStatistics(state, { before = null, editedId = null, affectedIds, catalogue }) {
  const ids = [...new Set(affectedIds)];
  const changes = [];
  const ordered = [...state.workouts].sort((a, b) => String(a.d).localeCompare(String(b.d)) || (a.start ?? 0) - (b.start ?? 0));
  for (const id of ids) {
    const relevant = ordered.filter(w => (w.entries || []).some(e => e.id === id) || (w.prs || []).includes(id));
    const needsRecords = !!editedId || relevant.some(w => (w.prs || []).includes(id)) || !!state.exWeights?.[id];
    if (needsRecords && !exerciseMetadata(state, catalogue, id)) throw new PlanError('PR/工作重量重算需要该动作的完整文字目录；请先更新目录', 'catalogue-required');
    if (needsRecords) {
      const bases = new Set(relevant.flatMap(w => w.entries.filter(e => e.id === id).map(basisOf)));
      if (bases.size > 1) throw new PlanError('同一动作的历史混用了不同重量口径；本版拒绝跨口径重算 PR，不会转换旧重量', 'unsupported');
      const days = new Map();
      for (const w of relevant) {
        date(w.d);
        const sameDay = days.get(w.d) || [];
        sameDay.push(w); days.set(w.d, sameDay);
      }
      if ([...days.values()].some(ws => ws.length > 1 && ws.some(w => !Number.isFinite(w.start)))) throw new PlanError('同一天多次训练缺少实际开始时间，无法确定 PR 先后；请在原 App 核对', 'unsupported');
    }
    let best = 0;
    for (const workout of relevant) {
      const entries = workout.entries.filter(e => e.id === id);
      const load = bestIn(workout, id, state, catalogue);
      const leads = beats(load, best, assisted(state, catalogue, entries[0] || { id }));
      if (leads) best = load;
      const had = workout.prs || [];
      const eligible = leads && (workout.id === editedId || had.includes(id));
      const next = had.filter(value => value !== id);
      if (eligible) next.push(id);
      if (!isDeepStrictEqual([...had].sort(), [...next].sort())) {
        changes.push({ workout_id: workout.id, date: workout.d, personal_records_before: [...had], personal_records_after: next });
        workout.prs = next;
      }
    }
    if (before && state.exWeights?.[id]) {
      const kept = state.exWeights[id];
      const old = bestIn(before, id, state, catalogue);
      const saved = state.workouts.find(w => w.id === editedId);
      const after = bestIn(saved, id, state, catalogue);
      const assistance = assisted(state, catalogue, { id });
      if (kept.w > 0 && kept.w === old && beats(old, after, assistance)) {
        let replacement = null;
        for (const w of ordered) {
          const load = bestIn(w, id, state, catalogue);
          if (beats(load, replacement?.w || 0, assistance)) replacement = { ...kept, w: load, d: w.d };
        }
        changes.push({ exercise_id: id, kept_weight_before: { weight: kept.w, date: kept.d },
          kept_weight_after: replacement ? { weight: replacement.w, date: replacement.d } : null });
        if (replacement) state.exWeights[id] = replacement; else delete state.exWeights[id];
      }
    }
  }
  return changes;
}
export function refreshWorkout(workout, state, catalogue) {
  for (const entry of workout.entries) entry.topW = bestLoad(entry, state, catalogue) || null;
  workout.vol = workoutVolume(workout, state, catalogue);
}
