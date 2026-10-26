// Independently implemented adapters for the published openGym v1.4.1/v1.4.2 contract.
// See docs/compatibility.md for the reviewed upstream interfaces and limitations.
import { PlanError } from './errors.mjs';
import { isDeepStrictEqual } from 'node:util';
import { only, text, number, integer, boolean, isObject } from './validate.mjs';

export const WEIGHT_BASES = { as_recorded: 'as', per_dumbbell: 'each', pair_total: 'total' };
export const phaseOf = row => row?.phase ? row.phase : row?.warmup === true ? 'warmup' : 'work';
export const hasSides = row => isObject(row?.sides) && isObject(row.sides.L) && isObject(row.sides.R);
export const hasCompletedSet = row => hasSides(row)
  ? row.sides.L.done === true || row.sides.R.done === true : row?.done === true;
export function assertCompletedEntry(entry) {
  if (!(entry.sets || []).some(hasCompletedSet)) throw new PlanError('每个保存动作至少需要一个已完成组；单侧组任一侧完成即可');
}
export function assertUnambiguousWeightLayout(entry) {
  if (entry.target?.dbLoad !== 'each') return;
  const unilateral = row => hasSides(row) || row.side === 'L' || row.side === 'R';
  const rows = entry.sets || [];
  // Native volume applies one multiplier to the entire occurrence, not per row.
  // Do not infer a single/bilateral meaning from only some of its rows.
  if (rows.some(unilateral) && rows.some(row => !unilateral(row))) throw new PlanError('同一动作项采用 per_dumbbell 时不能混合普通双手组和单侧组；请分为独立动作项', 'unsupported');
}
export const workoutKey = workout => workout.id ?? `legacy:${workout.d}|${workout.start ?? ''}`;
export const basisOf = entry => Object.entries(WEIGHT_BASES).find(([, native]) => native === entry?.target?.dbLoad)?.[0] || 'as_recorded';
export function exerciseMetadata(state, catalogue, id) {
  return (state.customEx || []).find(e => e.id === id) || (Object.hasOwn(catalogue.exercises || {},id) ? catalogue.exercises[id] : null);
}
export function exerciseName(state, catalogue, entry) {
  return [(state.customEx || []).find(e => e.id === entry.id)?.n, catalogue.names?.[entry.id], catalogue.exercises?.[entry.id]?.n, entry.muscleSnapshot?.n].find(v=>typeof v==='string'&&v) || null;
}
export function assertExercise(state, catalogue, id) {
  text(id, 100, 'exercise_id');
  if (!exerciseMetadata(state, catalogue, id) && !Object.hasOwn(catalogue.names || {}, id)) throw new PlanError('动作 ID 不在 openGym 动作目录或自定义动作中');
}
const SET_KEYS = ['weight', 'reps', 'seconds', 'phase', 'sides', 'side', 'rir', 'rpe', 'done'];
function effort(input, out) {
  if (input.rir != null && input.rpe != null) throw new PlanError('同一组不能同时填写 RIR 和 RPE');
  if (input.rir != null) out.rir = number(input.rir, 0, 10, 'rir');
  if (input.rpe != null) out.rpe = number(input.rpe, 6, 10, 'rpe');
}
function limb(input) {
  only(input, ['weight', 'reps', 'rir', 'rpe', 'done'], 'side');
  const out = { w: number(input.weight ?? 0, 0, 1000, 'side.weight'), r: integer(input.reps, 1, 1000, 'side.reps'),
    done: input.done === undefined ? true : boolean(input.done, 'side.done') };
  effort(input, out);
  return out;
}
export function aggregateSides(row) {
  const out = { ...row, sides: structuredClone(row.sides) };
  const limbs = [out.sides.L, out.sides.R];
  out.w = Math.max(...limbs.map(s => s.w));
  out.r = limbs.reduce((sum, s) => sum + s.r, 0);
  out.done = limbs.every(s => s.done === true);
  delete out.rir; delete out.rpe;
  const rirs = limbs.map(s => s.rir).filter(v => v != null);
  const rpes = limbs.map(s => s.rpe).filter(v => v != null);
  if (rirs.length) out.rir = Math.min(...rirs);
  else if (rpes.length) out.rpe = Math.max(...rpes);
  return out;
}
export function normalizeSet(input) {
  only(input, SET_KEYS, 'set');
  let row;
  if (input.sides !== undefined) {
    if (['weight', 'reps', 'seconds', 'side', 'rir', 'rpe', 'done'].some(k => input[k] !== undefined)) throw new PlanError('单侧次数组只能以 sides.L / sides.R 记录实际数据');
    only(input.sides, ['L', 'R'], 'sides');
    row = aggregateSides({ mode: 'reps', sides: { L: limb(input.sides.L), R: limb(input.sides.R) } });
  } else {
    if ((input.reps !== undefined) === (input.seconds !== undefined)) throw new PlanError('必须且只能填写 reps 或 seconds');
    row = { w: number(input.weight ?? 0, 0, 1000, 'weight'), done: input.done === undefined ? true : boolean(input.done, 'done') };
    if (input.seconds !== undefined) {
      row.mode = 'time'; row.sec = integer(input.seconds, 1, 86400, 'seconds');
      if (input.side !== undefined) {
        if (!['L', 'R'].includes(input.side)) throw new PlanError('side must be L or R');
        row.side = input.side;
      }
    } else {
      if (input.side !== undefined) throw new PlanError('单侧次数组需要显式 sides.L 和 sides.R，不得乘二猜测');
      row.mode = 'reps'; row.r = integer(input.reps, 1, 1000, 'reps');
    }
    effort(input, row);
  }
  if (input.phase !== undefined && !['warmup', 'work'].includes(input.phase)) throw new PlanError('phase must be warmup or work');
  // An unstamped API writer must send its intended phase explicitly. Otherwise
  // the server's unknown-field preservation could revive a replaced warmup tag.
  row.phase = input.phase ?? 'work';
  row.warmup = row.phase === 'warmup';
  return row;
}
function inputOf(row) {
  const out = { weight: row.w ?? 0, done: row.done === true };
  if (hasSides(row)) {
    delete out.weight; delete out.done;
    out.sides = Object.fromEntries(['L', 'R'].map(k => [k, inputOf(row.sides[k])]));
  } else if (row.mode === 'time' || row.sec != null) out.seconds = row.sec;
  else out.reps = row.r;
  if (row.side != null) out.side = row.side;
  if (row.phase != null || row.warmup != null) out.phase = phaseOf(row);
  for (const k of ['rir', 'rpe']) if (row[k] != null && !hasSides(row)) out[k] = row[k];
  return out;
}
export function patchSet(original, patch) {
  only(patch, SET_KEYS, 'set changes');
  if ((original.type === 'dropset' || original.type === 'restpause' || original.drops || original.clusters)
    && Object.keys(patch).some(k => k !== 'phase')) throw new PlanError('复杂递减组/休息暂停组仅可读取或整体移除；请在原 App 编辑其内部数据', 'unsupported');
  const input = inputOf(original);
  const baseline = normalizeSet(input);
  if (patch.sides !== undefined) {
    if (!hasSides(original)) throw new PlanError('不能猜测普通组拆成两侧后的数值；请替换为完整新组', 'unsupported');
    only(patch.sides, ['L', 'R'], 'side changes');
    for (const key of ['L', 'R']) {
      if (patch.sides[key] === undefined) continue;
      only(patch.sides[key], ['weight', 'reps', 'rir', 'rpe', 'done'], 'side changes');
      input.sides[key] = { ...input.sides[key], ...patch.sides[key] };
      if (patch.sides[key].rir != null && patch.sides[key].rpe === undefined) delete input.sides[key].rpe;
      if (patch.sides[key].rpe != null && patch.sides[key].rir === undefined) delete input.sides[key].rir;
    }
  }
  for (const [key, value] of Object.entries(patch)) if (key !== 'sides') input[key] = value;
  if (patch.reps !== undefined) delete input.seconds;
  if (patch.seconds !== undefined) delete input.reps;
  if (patch.rir != null && patch.rpe === undefined) delete input.rpe;
  if (patch.rpe != null && patch.rir === undefined) delete input.rir;
  const normalized = normalizeSet(input);
  if (isDeepStrictEqual(baseline, normalized)) return structuredClone(original);
  const out = { ...structuredClone(original), ...structuredClone(normalized) };
  for (const key of ['r', 'sec', 'sides', 'side', 'rir', 'rpe']) if (!(key in normalized)) delete out[key];
  if (hasSides(normalized)) for (const key of ['L', 'R']) out.sides[key] = { ...structuredClone(original.sides[key]), ...normalized.sides[key] };
  if (hasSides(normalized)) for (const key of ['L', 'R']) for (const field of ['rir', 'rpe']) if (!(field in normalized.sides[key])) delete out.sides[key][field];
  return out;
}
export function normalizeEntry(input, { state, catalogue }) {
  only(input, ['exercise_id', 'sets', 'note', 'weight_basis'], 'exercise');
  assertExercise(state, catalogue, input.exercise_id);
  if (!Array.isArray(input.sets) || input.sets.length < 1 || input.sets.length > 30) throw new PlanError('每个动作需要 1-30 组实际数据');
  const sets = input.sets.map(normalizeSet);
  const entry = { id: input.exercise_id, sets };
  if (input.note !== undefined) entry.note = text(input.note, 500, 'exercise.note', { empty: true });
  const target = {};
  if (sets.some(s => hasSides(s) || s.side)) target.side = true;
  if (input.weight_basis !== undefined) {
    if (!Object.hasOwn(WEIGHT_BASES, input.weight_basis)) throw new PlanError('Unknown weight_basis');
    const meta = exerciseMetadata(state, catalogue, entry.id);
    if (input.weight_basis !== 'as_recorded' && !['dumbbell', 'kettlebell'].includes(meta?.eq)) throw new PlanError('显式哑铃口径需要完整动作元数据及 dumbbell/kettlebell 器材；请更新文字目录', 'unsupported');
    target.dbLoad = WEIGHT_BASES[input.weight_basis];
  }
  if (Object.keys(target).length) entry.target = target;
  assertCompletedEntry(entry);
  assertUnambiguousWeightLayout(entry);
  entry.topW = bestLoad(entry, state, catalogue) || null;
  return entry;
}
function storedNumber(value) {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new PlanError('训练包含无法安全计算的旧数值，请在原 App 核对', 'unsupported');
  return value;
}
export function modeOf(row, entry = {}) {
  return row.mode || entry.target?.mode || (row.sec != null || row.seconds != null || row.durationSec != null ? 'time' : row.min != null || row.speed != null ? 'cardio' : 'reps');
}
function rowVolume(row) {
  if (hasSides(row)) return ['L', 'R'].reduce((sum, key) => sum + rowVolume(row.sides[key]), 0);
  if (row.done !== true) return 0;
  const main = storedNumber(row.w) * storedNumber(row.r);
  const drops = row.type === 'dropset' && Array.isArray(row.drops) ? row.drops : [];
  return main + drops.reduce((sum, drop) => sum + storedNumber(drop.w) * storedNumber(drop.r), 0);
}
function loadFactor(entry, state, catalogue) {
  if (entry.target?.dbLoad !== 'each') return 1;
  const meta = exerciseMetadata(state, catalogue, entry.id);
  if (!meta && !entry.target?.side) throw new PlanError('无法确认哑铃单只/双只容量，请先更新文字目录', 'unsupported');
  const one = entry.target?.side || /\b(?:one|single)[ -]?(?:arm|hand|handed)\b/i.test(meta?.n || '');
  return one ? 1 : 2;
}
export function workoutVolume(workout, state = {}, catalogue = {}) {
  for (const e of workout.entries || []) {
    assertUnambiguousWeightLayout(e);
    for (const s of e.sets || []) {
      if (!['warmup','work'].includes(phaseOf(s)) || !['reps','time','cardio'].includes(modeOf(s,e))) throw new PlanError('Unsupported stored set mode/phase', 'unsupported');
      if (modeOf(s,e)!=='reps' && Number(s.r)>0) throw new PlanError('计时/有氧旧组还包含次数，无法安全重算容量，请在原 App 核对', 'unsupported');
    }
  }
  return (workout.entries || []).reduce((sum, entry) => sum + loadFactor(entry, state, catalogue) * (entry.sets || []).reduce((v, row) =>
    v + (phaseOf(row) === 'warmup' || modeOf(row, entry) !== 'reps' ? 0 : rowVolume(row)), 0), 0);
}
export function assisted(state, catalogue, entry) {
  const meta = exerciseMetadata(state, catalogue, entry.id);
  return entry.assisted ?? entry.target?.assisted ?? meta?.assisted ?? (meta?.eq === 'leverage machine' && /\bassist(?:ed)?\b/i.test(meta?.n || ''));
}
export function beats(load, previous, assistance) {
  return load > 0 && (previous <= 0 || (assistance ? load < previous : load > previous));
}
export function bestLoad(entry, state = {}, catalogue = {}) {
  const work = (entry.sets || []).filter(row => phaseOf(row) !== 'warmup');
  const reps = work.filter(row => modeOf(row, entry) === 'reps' && (row.done === true || hasSides(row)));
  const rows = reps.length ? reps : work;
  const assistance = assisted(state, catalogue, entry);
  const weights = rows.flatMap(row => hasSides(row) ? [row.sides.L, row.sides.R] : [row])
    .filter(row => row.done === true).map(row => storedNumber(row.w)).filter(w => !assistance || w > 0);
  if (weights.length) return assistance ? Math.min(...weights) : Math.max(...weights);
  if (modeOf({},entry)==='reps' && !entry.sets?.some(row => phaseOf(row) === 'warmup') && work.every(row => modeOf(row, entry) === 'reps')) return storedNumber(entry.topW);
  return 0;
}
export function publicSet(row, entry = {}) {
  const mode=modeOf(row,entry),phase=phaseOf(row);
  const out = { mode: typeof mode==='string'?mode:null, phase: typeof phase==='string'?phase:null, done: row.done === true };
  for (const [native, external] of Object.entries({ w: 'weight', r: 'reps', sec: 'seconds', min: 'minutes', speed: 'speed', rir: 'rir', rpe: 'rpe', side: 'side', type: 'type', failure: 'failure' })) {
    if (typeof row[native] === 'number' || typeof row[native] === 'boolean' || (['side', 'type'].includes(native) && typeof row[native] === 'string')) out[external] = row[native];
  }
  if (out.seconds === undefined) for (const alias of ['seconds', 'durationSec']) if (typeof row[alias] === 'number') out.seconds = row[alias];
  if (hasSides(row)) out.sides = { L: { ...publicSet(row.sides.L), phase: out.phase }, R: { ...publicSet(row.sides.R), phase: out.phase } };
  if (Array.isArray(row.drops)) out.drops = row.drops.map(d => Object.fromEntries([['weight',d?.w],['reps',d?.r]].filter(([,v])=>typeof v==='number')));
  if (Array.isArray(row.clusters)) out.clusters = row.clusters.map(c => Object.fromEntries([['reps',c?.r],['rest_seconds',c?.restSec]].filter(([,v])=>typeof v==='number')));
  return out;
}
export function publicRoutineExtras(config){
  const out={};
  if(Object.hasOwn(config,'subs')){
    if(!Array.isArray(config.subs)||config.subs.length>5||!config.subs.every(id=>typeof id==='string'&&id.length>0&&id.length<=100))throw new PlanError('Unsupported stored substitutes', 'unsupported');
    out.subs=[...config.subs];
  }
  for(const key of ['warmupRestSec','sideRestSec'])if(Object.hasOwn(config,key)){
    if(typeof config[key]!=='number'||!Number.isFinite(config[key])||config[key]<0)throw new PlanError('Unsupported stored rest configuration', 'unsupported');
    out[key]=config[key];
  }
  if(Object.hasOwn(config,'warmupRestOff')){if(typeof config.warmupRestOff!=='boolean')throw new PlanError('Unsupported stored warmupRestOff', 'unsupported');out.warmupRestOff=config.warmupRestOff;}
  return out;
}
export function publicEntry(entry, index, state, catalogue) {
  if (typeof entry.id !== 'string') throw new PlanError('Unsupported exercise identity', 'unsupported');
  const target = Object.fromEntries(Object.entries(entry.target || {}).filter(([key, value]) =>
    ['id', 'mode', 'side', 'sets', 'reps', 'sec', 'min', 'speed', 'weight', 'dbLoad', 'bodyweight', 'restSec'].includes(key)
    && ['string', 'number', 'boolean'].includes(typeof value)));
  Object.assign(target,publicRoutineExtras(entry.target||{}));
  return { exercise_index: index, exercise_id: entry.id, exercise_name: exerciseName(state, catalogue, entry), target,
    weight_basis: basisOf(entry), note: typeof entry.note === 'string' ? entry.note : null,
    sets: (entry.sets || []).map(row => publicSet(row, entry)) };
}
