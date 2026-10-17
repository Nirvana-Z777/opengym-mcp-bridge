import { randomUUID } from 'node:crypto';
import { PlanError } from './plan.mjs';

const obj = v => v && typeof v === 'object' && !Array.isArray(v);
const hasOnly = (v, keys, label) => {
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new PlanError(`${label} 字段 ${k} 不在允许列表中`);
};
const int = (v, lo, hi, label) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new PlanError(`${label} 必须是 ${lo} 到 ${hi} 的整数`);
  return v;
};
const num = (v, lo, hi, label) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new PlanError(`${label} 必须是 ${lo} 到 ${hi} 的有效数字`);
  return v;
};
const isoDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
};
const exerciseName = (state, names, id) => names[id] || (Array.isArray(state.customEx) ? state.customEx.find(e => e?.id === id)?.n : null) || null;

// Stable content signature excludes generated IDs and timestamps, catching exact re-imports.
export function workoutSignature(w) {
  const entries = (Array.isArray(w?.entries) ? w.entries : []).map(e => ({
    id: String(e?.id || ''),
    sets: (Array.isArray(e?.sets) ? e.sets : []).map(s => ({
      w: s?.w ?? 0,
      ...(Number.isFinite(s?.r) ? { r: s.r } : {}),
      ...(Number.isFinite(s?.sec) ? { sec: s.sec } : {}),
      ...(Number.isFinite(s?.min) ? { min: s.min } : {}),
      ...(Number.isFinite(s?.speed) ? { speed: s.speed } : {}),
      ...(Number.isFinite(s?.rir) ? { rir: s.rir } : {}),
      ...(Number.isFinite(s?.rpe) ? { rpe: s.rpe } : {}),
    })),
  }));
  return JSON.stringify({d:w?.d||'',name:w?.name||'',entries});
}

export function normalizeWorkoutInput(input, { state, names = {} } = {}) {
  if (!obj(input)) throw new PlanError('每条 workout 必须是对象');
  hasOnly(input, ['date','name','routine_id','body_weight','started_at','duration_minutes','exercises'], 'workout');
  if (!isoDate(input.date)) throw new PlanError('date 必须是有效日期 YYYY-MM-DD；未知日期不要猜测');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || [...name].length > 60) throw new PlanError('name 必须是 1-60 个字符的训练名称');
  if (!Array.isArray(input.exercises) || input.exercises.length < 1 || input.exercises.length > 30) throw new PlanError('exercises 必须包含 1-30 个动作');
  const customIds = new Set((Array.isArray(state?.customEx) ? state.customEx : []).map(x => x?.id).filter(Boolean));
  const entries = input.exercises.map((ex, exIndex) => {
    if (!obj(ex)) throw new PlanError(`第 ${exIndex+1} 个动作必须是对象`);
    hasOnly(ex, ['exercise_id','sets'], `第 ${exIndex+1} 个动作`);
    if (typeof ex.exercise_id !== 'string' || !ex.exercise_id || ex.exercise_id.length > 64) throw new PlanError(`第 ${exIndex+1} 个动作缺少有效 exercise_id`);
    if (!Object.hasOwn(names, ex.exercise_id) && !customIds.has(ex.exercise_id)) throw new PlanError(`动作 ID ${ex.exercise_id} 不在 openGym 动作目录中；请先调用 search_exercises 确认 ID`);
    if (!Array.isArray(ex.sets) || ex.sets.length < 1 || ex.sets.length > 30) throw new PlanError(`动作 ${exerciseName(state,names,ex.exercise_id) || ex.exercise_id} 必须包含 1-30 组实际完成的数据`);
    const sets = ex.sets.map((s, setIndex) => {
      if (!obj(s)) throw new PlanError(`动作 ${ex.exercise_id} 第 ${setIndex+1} 组必须是对象`);
      hasOnly(s, ['weight','reps','seconds','rir','rpe'], `动作 ${ex.exercise_id} 第 ${setIndex+1} 组`);
      const hasReps = s.reps !== undefined;
      const hasSeconds = s.seconds !== undefined;
      if (hasReps === hasSeconds) throw new PlanError(`动作 ${ex.exercise_id} 第 ${setIndex+1} 组必须且只能填写 reps（次数）或 seconds（持续秒数）`);
      const w = s.weight === undefined ? 0 : num(s.weight, 0, 1000, `动作 ${ex.exercise_id} 第 ${setIndex+1} 组 weight`);
      if (s.rir !== undefined && s.rpe !== undefined) throw new PlanError('同一组不能同时填写 RIR 和 RPE');
      const set = hasSeconds
        ? { w, sec: int(s.seconds, 1, 86400, `动作 ${ex.exercise_id} 第 ${setIndex+1} 组 seconds`), done: true }
        : { w, r: int(s.reps, 1, 1000, `动作 ${ex.exercise_id} 第 ${setIndex+1} 组 reps`), done: true };
      if (hasSeconds && (s.rir !== undefined || s.rpe !== undefined)) throw new PlanError('计时组暂不支持 RIR/RPE；请只记录实际持续秒数');
      if (s.rir !== undefined) set.rir = num(s.rir, 0, 10, 'RIR');
      if (s.rpe !== undefined) set.rpe = num(s.rpe, 6, 10, 'RPE');
      return set;
    });
    const maxWeight = Math.max(...sets.map(s => s.w));
    return { id: ex.exercise_id, sets, topW: maxWeight > 0 ? maxWeight : null };
  });
  let routineId;
  if (input.routine_id !== undefined) {
    if (typeof input.routine_id !== 'string' || !input.routine_id || input.routine_id.length > 100) throw new PlanError('routine_id 必须是当前存在的训练模板 ID');
    if (!(Array.isArray(state?.routines) ? state.routines : []).some(r => r?.id === input.routine_id)) throw new PlanError(`routine_id ${input.routine_id} 不存在；历史训练可不关联模板`);
    routineId = input.routine_id;
  }
  let bw;
  if (input.body_weight !== undefined) bw = num(input.body_weight, 0, 500, 'body_weight');
  let start, end;
  if (input.started_at !== undefined) {
    if (typeof input.started_at !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(input.started_at)) throw new PlanError('started_at 必须是带时区的 ISO 时间，例如 2000-01-01T12:00:00Z；不知道时间可省略');
    start = Date.parse(input.started_at);
    if (!Number.isFinite(start)) throw new PlanError('started_at 不是有效时间');
  }
  if (input.duration_minutes !== undefined) {
    if (start === undefined) throw new PlanError('只有知道 started_at 时才能填写 duration_minutes；不知道时长可省略，避免编造时间');
    end = start + int(input.duration_minutes, 1, 600, 'duration_minutes') * 60000;
  }
  if (!obj(state)) throw new PlanError('openGym 训练状态不存在');
  return {
    id: randomUUID(), d: input.date, name,
    ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }),
    ...(routineId === undefined ? {} : { routineId }), ...(bw === undefined ? {} : { bw }),
    entries, prs: [], vol: entries.reduce((total,e) => total + e.sets.reduce((sum,s) => sum + (Number.isFinite(s.r) ? s.w*s.r : 0), 0), 0),
  };
}

export function workoutPreview(workout, state, names={}) {
  return {
    workout_id:workout.id,date:workout.d,name:workout.name,
    ...(Number.isFinite(workout.start)?{started_at:new Date(workout.start).toISOString()}:{}),
    ...(Number.isFinite(workout.end)&&Number.isFinite(workout.start)?{duration_minutes:Math.round((workout.end-workout.start)/60000)}:{}),
    ...(Number.isFinite(workout.bw)?{body_weight:workout.bw,unit:state?.unit||'kg'}:{}),
    exercise_count:workout.entries.length,set_count:workout.entries.reduce((n,e)=>n+e.sets.length,0),
    volume:Math.round(workout.vol*100)/100,unit:state?.unit||'kg',
    exercises:workout.entries.map(e=>({exercise_id:e.id,exercise_name:exerciseName(state,names,e.id),sets:e.sets.map(s=>({weight:s.w,...(s.r===undefined?{}:{reps:s.r}),...(s.sec===undefined?{}:{seconds:s.sec}),...(s.rir===undefined?{}:{rir:s.rir}),...(s.rpe===undefined?{}:{rpe:s.rpe})}))})),
  };
}

export function verifyLoggedWorkout(actual, expected) {
  if (!actual || actual.id !== expected.id || actual.d !== expected.d || actual.name !== expected.name) return false;
  if (workoutSignature(actual) !== workoutSignature(expected)) return false;
  if (Number.isFinite(expected.start) && actual.start !== expected.start) return false;
  if (Number.isFinite(expected.end) && actual.end !== expected.end) return false;
  return true;
}
