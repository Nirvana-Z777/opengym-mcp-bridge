import { ROUTINE_EDIT_TYPES,applyRoutineEditAction } from './routine-editor.mjs';
import { FeatureService } from './v040.mjs';
import { randomUUID } from 'node:crypto';
import { PlanError } from './errors.mjs';
export { PlanError } from './errors.mjs';
import { normalizeWorkoutInput, workoutSignature, workoutPreview } from './workout-log.mjs';
import { GuardedWrites } from './write-safety.mjs';
import { listCustom, changeCustomExercises } from './custom-exercises.mjs';
import { listWorkouts, getWorkout, exerciseHistory } from './workout-query.mjs';
import { editWorkout } from './workout-edit.mjs';
import { insertHistory, updateHistoryStatistics } from './workout-stats.mjs';
import { publicSet } from './workout-data.mjs';
const clone = v => structuredClone(v);
const obj = v => v && typeof v === 'object' && !Array.isArray(v);
const nameOf = r => String(r?.name || r?.id || '未知训练');
const exerciseName = (state, names, id) => names[id] || (Array.isArray(state.customEx) ? state.customEx.find(e=>e.id===id)?.n : null) || null;
const findRoutine = (state, id) => {
  const r = (state.routines || []).find(v => v && v.id === id);
  if (!r) throw new PlanError(`找不到训练模板 ${id}；请先调用 get_plan 获取有效的 routine_id`);
  return r;
};

const hasOnly = (action, names) => {
  for (const k of Object.keys(action)) if (!names.includes(k)) throw new PlanError(`字段 ${k} 不在允许列表中`);
};
const boundedInt = (v, lo, hi, label) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new PlanError(`${label} 必须是 ${lo} 到 ${hi} 的整数`);
  return v;
};
const isIsoDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(s + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
};

export function publicPlan(state, names={}) {
  if (!obj(state)) throw new PlanError('当前账号还没有训练状态；请先在 openGym App 中保存并同步一次');
  return {
    unit: state.unit || 'kg',
    rev: state._rev ?? null,
    routines: (Array.isArray(state.routines) ? state.routines : []).slice(0, 60).map(r => ({
      id: r.id, name: nameOf(r),
      exercises: (Array.isArray(r.ex) ? r.ex : []).slice(0, 60).map((x, index) => ({
        exercise_index: index, exercise_id: x.id, exercise_name: exerciseName(state,names,x.id), sets: x.sets, reps: x.reps,
        weight: x.weight, ...(x.restSec === undefined ? {} : { rest_sec: x.restSec }),
      })),
    })),
    week: obj(state.week) ? state.week : {},
    date_overrides: obj(state.dayPlan) ? state.dayPlan : {},
    rotation_active: !!(obj(state.queue) && Array.isArray(state.queue.ids) && state.queue.ids.length),
  };
}

export function publicRecent(state, limit = 10, names={}) {
  boundedInt(limit, 1, 20, 'limit');
  if (!obj(state)) throw new PlanError('还没有任何同步的训练数据');
  const workouts = Array.isArray(state.workouts) ? state.workouts : [];
  return {
    unit: state.unit || 'kg',
    total: workouts.length,
    workouts: [...workouts].sort((a,b) => (b?.start || 0)-(a?.start || 0) || String(b?.d||'').localeCompare(String(a?.d||'')))
      .slice(0,limit).map(w => ({
        workout_id:w.id, date:w.d, name:w.name, duration_minutes:
          Number.isFinite(w.end) && Number.isFinite(w.start) && w.end>=w.start
            ? Math.round((w.end-w.start)/60000):null,
        exercises: (Array.isArray(w.entries)?w.entries:[]).slice(0,40).map(e=>({
          exercise_id: e.id, exercise_name:exerciseName(state,names,e.id),
          sets: (Array.isArray(e.sets)?e.sets:[]).slice(0,30).map(s=>({
            ...publicSet(s), reps:s.r ?? null, weight:s.w ?? null, done:!!s.done,
            ...(Number.isFinite(s.rir)?{rir:s.rir}:{}),
            ...(Number.isFinite(s.rpe)?{rpe:s.rpe}:{})
          }))
        }))
      }))
  };
}

export function publicSummary(state) {
  if (!obj(state)) throw new PlanError('还没有同步数据');
  const weight = Array.isArray(state.bodyweight) ? state.bodyweight : [];
  const workouts = Array.isArray(state.workouts) ? state.workouts : [];
  const lastWeight = [...weight].sort((a,b)=>String(b?.d||'').localeCompare(String(a?.d||'')))[0] || null;
  const lastWorkout = [...workouts].sort((a,b)=>String(b?.d||'').localeCompare(String(a?.d||'')))[0] || null;
  return {
    unit:state.unit || 'kg', routine_count:(state.routines || []).length,
    workout_count:workouts.length, last_workout: lastWorkout ? {date:lastWorkout.d,name:lastWorkout.name}:null,
    last_body_weight:lastWeight ? {date:lastWeight.d,weight:lastWeight.w}:null,
  };
}

function validRoutineRef(state, id, label) {
  if (id === null) return null;
  if (typeof id !== 'string' || id.length > 100) throw new PlanError(`${label} 必须是已存在的 routine_id 或 null`);
  return findRoutine(state,id).id;
}

export function applyActions(inputState, actions, names={}) {
  if (!obj(inputState)) throw new PlanError('训练状态不存在');
  if (!Array.isArray(actions) || actions.length<1 || actions.length>20) throw new PlanError('actions 必须是 1 到 20 条修改');
  const state=clone(inputState);
  if (!Array.isArray(state.routines) || !state.routines.every(obj)) throw new PlanError('openGym 训练模板数据无效');
  const changes=[];
  const normalizedActions=[];
  for(const action of actions){
    if(!obj(action) || typeof action.type !=='string') throw new PlanError('每条 action 必须包含 type');
    if(ROUTINE_EDIT_TYPES.has(action.type)){changes.push(...applyRoutineEditAction(state,action,names));normalizedActions.push(clone(action));continue;}
    if(action.type==='create_routine'){
      hasOnly(action,['type','id','name','emoji','exercises','weekdays']);
      const name=typeof action.name==='string'?action.name.trim():'';
      if(!name || [...name].length>60) throw new PlanError('新训练模板的 name 必须是 1-60 个字符');
      const id=action.id || randomUUID();
      if(typeof id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new PlanError('训练模板 ID 无效');
      if(state.routines.some(r=>r.id===id)) throw new PlanError('训练模板 ID '+id+' 已存在');
      if(action.emoji!==undefined && (typeof action.emoji!=='string' || [...action.emoji].length>32)) throw new PlanError('emoji 必须是最多 32 个字符的字符串');
      if(!Array.isArray(action.exercises) || action.exercises.length<1 || action.exercises.length>12) throw new PlanError('exercises 必须包含 1-12 个动作');
      const customIds=new Set((Array.isArray(state.customEx)?state.customEx:[]).map(x=>x?.id).filter(Boolean));
      const seen=new Set();
      const exercises=action.exercises.map((ex,index)=>{
        if(!obj(ex)) throw new PlanError('第 '+(index+1)+' 个动作必须是对象');
        hasOnly(ex,['exercise_id','sets','reps','weight']);
        const exerciseId=ex.exercise_id;
        if(typeof exerciseId!=='string' || !exerciseId || exerciseId.length>64) throw new PlanError('第 '+(index+1)+' 个动作缺少有效 exercise_id');
        if(!Object.hasOwn(names,exerciseId) && !customIds.has(exerciseId)) throw new PlanError('动作 ID '+exerciseId+' 不在已加载的 openGym 动作目录中；先运行 node src/catalogue.mjs，再用 search_exercises 查询动作');
        if(seen.has(exerciseId)) throw new PlanError('同一个训练模板不能重复添加动作 ID '+exerciseId);
        seen.add(exerciseId);
        const sets=boundedInt(ex.sets,1,12,'第 '+(index+1)+' 个动作的 sets');
        const reps=boundedInt(ex.reps,1,100,'第 '+(index+1)+' 个动作的 reps');
        const weight=ex.weight===undefined?0:ex.weight;
        if(typeof weight!=='number' || !Number.isFinite(weight) || weight<0 || weight>1000) throw new PlanError('第 '+(index+1)+' 个动作的 weight 必须是 0 到 1000 的有限数字');
        return {id:exerciseId,sets,reps,weight};
      });
      const weekdays=action.weekdays===undefined?[]:action.weekdays;
      if(!Array.isArray(weekdays) || weekdays.length>7 || weekdays.some(d=>!Number.isInteger(d)||d<0||d>6) || new Set(weekdays).size!==weekdays.length) throw new PlanError('weekdays 必须是 0-6 之间不重复的星期数字组（0=周日）');
      const routine={id,name,...(action.emoji?{emoji:action.emoji}:{}),ex:exercises};
      state.routines.push(routine);
      changes.push({type:'create_routine',routine_id:id,name,exercises:exercises.map((ex,index)=>({exercise_index:index,exercise_id:ex.id,exercise_name:exerciseName(state,names,ex.id),sets:ex.sets,reps:ex.reps,weight:ex.weight}))});
      state.week=obj(state.week)?state.week:{};
      for(const day of weekdays){
        const from=state.week[day]||null;
        if(from!==id){state.week[day]=id;changes.push({type:'assign_weekday',weekday:day,from,to:id,routine_id:id,routine_name:name});}
      }
      normalizedActions.push({...clone(action),id,weekdays:[...weekdays]});
      continue;
    }
    if(action.type==='assign_weekday'){
      hasOnly(action,['type','weekday','routine_id']);
      const day=boundedInt(action.weekday,0,6,'weekday (0=周日, 1=周一)');
      const id=validRoutineRef(state,action.routine_id,'routine_id');
      state.week=obj(state.week) ? state.week : {};
      const from=state.week[day] || null;
      if(id===null) delete state.week[day]; else state.week[day]=id;
      if(from !== id) changes.push({type:action.type,weekday:day,from,to:id});
      normalizedActions.push(clone(action));
      continue;
    }
    if(action.type==='override_date'){
      hasOnly(action,['type','date','routine_id']);
      if(!isIsoDate(action.date)) throw new PlanError('date 必须是有效日期 YYYY-MM-DD');
      const id=action.routine_id==='rest'?'rest':validRoutineRef(state,action.routine_id,'routine_id');
      state.dayPlan=obj(state.dayPlan)?state.dayPlan:{};
      const from=state.dayPlan[action.date] || null;
      if(id===null) delete state.dayPlan[action.date]; else state.dayPlan[action.date]=id;
      if(from !== id) changes.push({type:action.type,date:action.date,from,to:id});
      normalizedActions.push(clone(action));
      continue;
    }
    if(action.type==='set_exercise_target'){
      hasOnly(action,['type','routine_id','exercise_index','sets','reps','weight']);
      const routine=findRoutine(state,action.routine_id);
      if(!Array.isArray(routine.ex)) throw new PlanError(`训练模板 ${routine.id} 没有动作列表`);
      const idx=boundedInt(action.exercise_index,0,routine.ex.length-1,'exercise_index');
      const exercise=routine.ex[idx];
      if(!obj(exercise) || !exercise.id) throw new PlanError(`模板 ${routine.id} 的第 ${idx} 个动作无效`);
      const fields=['sets','reps','weight'].filter(k=>Object.hasOwn(action,k));
      if(!fields.length) throw new PlanError('set_exercise_target 至少指定 sets、reps 或 weight 之一');
      const from={},to={};
      for(const field of fields){
        const val=action[field];
        if(field==='sets') boundedInt(val,1,12,field);
        if(field==='reps') boundedInt(val,1,100,field);
        if(field==='weight' && (typeof val!=='number'||!Number.isFinite(val)||val<0||val>1000)) throw new PlanError('weight 必须为 0 到 1000 的有限数字');
        if(exercise[field]!==val){ from[field]=exercise[field]??null; to[field]=val; exercise[field]=val; }
      }
      if(Object.keys(to).length) changes.push({type:action.type,routine_id:routine.id,routine_name:nameOf(routine),exercise_index:idx,exercise_id:exercise.id,from,to});
      normalizedActions.push(clone(action));
      continue;
    }
    normalizedActions.push(clone(action));
    throw new PlanError('不支持的修改类型：'+action.type);
  }
  if(!changes.length) throw new PlanError('所有内容与当前计划相同，没有实际修改');
  return {state,changes,normalizedActions};
}

export class PersonalGymBridge {
  constructor({client, writes=false, now=Date.now, ttl=600000, loadNames=async()=>({}), loadCatalogue, backup, localDirectory}){
    this.client=client; this.loadNames=loadNames; this.loadCatalogue=loadCatalogue; this.writes=writes;
    this.features=new FeatureService(this,localDirectory);
    this.writer=new GuardedWrites({client,writes,backup,now,ttl});
  }
  async catalogue(){return this.loadCatalogue ? await this.loadCatalogue() : {names:await this.loadNames(),exercises:{}};}
  async getStatus(){
    const auth=await this.client.refreshLogin(); const snap=await this.client.getData();
    return {connected:true,profile:typeof auth.user?.name==='string'?auth.user.name:'已连接',rev:snap.rev,has_state:!!snap.state,writes_enabled:this.writes};
  }
  async getPlan(){const snap=await this.client.getData();return {...publicPlan(snap.state,(await this.catalogue()).names),server_revision:snap.rev};}
  async searchExercises({query,limit=15}={}){
    if(typeof query!=='string'||!query.trim()||query.length>100)throw new PlanError('query 必须是 1-100 字的动作名称或 ID');
    boundedInt(limit,1,30,'limit');
    const names={...(await this.catalogue()).names}; const snap=await this.client.getData();
    for(const e of snap.state?.customEx||[])if(typeof e.id==='string'&&typeof e.n==='string')names[e.id]=e.n;
    if(!Object.keys(names).length)throw new PlanError('动作目录尚未加载；请运行 node src/catalogue.mjs');
    const q=query.trim().toLocaleLowerCase();
    const results=Object.entries(names).filter(([id,name])=>id.toLowerCase()===q||String(name).toLocaleLowerCase().includes(q)).slice(0,limit).map(([exercise_id,exercise_name])=>({exercise_id,exercise_name}));
    return {query:query.trim(),count:results.length,results};
  }
  async getSummary(){const snap=await this.client.getData();return {...publicSummary(snap.state),server_revision:snap.rev};}
  async getRecent({limit=10}={}){const snap=await this.client.getData();return publicRecent(snap.state,limit,(await this.catalogue()).names);}
  async preview({actions}){
    const snap=await this.client.getData();const planned=applyActions(snap.state,actions,(await this.catalogue()).names);
    return this.writer.prepare('plan',snap,planned.state,{changes:planned.changes},{changes:planned.changes});
  }
  async apply(input){return this.writer.commit('plan',input);}
  async previewWorkoutLog({workouts}){
    if(!Array.isArray(workouts)||workouts.length<1||workouts.length>10)throw new PlanError('workouts 必须包含 1-10 次训练');
    const snap=await this.client.getData();const catalogue=await this.catalogue();
    const records=workouts.map(w=>normalizeWorkoutInput(w,{state:snap.state,catalogue,names:catalogue.names}));
    const signatures=new Set((snap.state.workouts||[]).map(workoutSignature));
    const batch=new Set();
    for(const w of records){const key=workoutSignature(w);if(signatures.has(key))throw new PlanError('疑似重复：相同的训练历史已存在，整批未写入','duplicate');if(batch.has(key))throw new PlanError('批量导入中存在重复训练，整批未写入','duplicate');batch.add(key);}
    const next=clone(snap.state);next.workouts=insertHistory(next.workouts||[],records);
    const statistics=updateHistoryStatistics(next,{affectedIds:records.flatMap(w=>w.entries.map(e=>e.id)),catalogue});
    const previews=records.map(w=>workoutPreview(w,next,catalogue.names,catalogue));
    return this.writer.prepare('workout_log',snap,next,{workout_count:records.length,total_exercises:records.reduce((n,w)=>n+w.entries.length,0),total_sets:records.reduce((n,w)=>n+w.entries.reduce((s,e)=>s+e.sets.length,0),0),records:previews,statistics_changes:statistics},
      {logged_count:records.length,records:records.map(w=>({workout_id:w.id,date:w.d,name:w.name}))});
  }
  async logWorkout(input,options={}){return this.writer.commit(options.kind||'workout_log',input,options);}
  async listCustomExercises(input={}){const snap=await this.client.getData();return listCustom(snap.state,input);}
  async previewCustomExerciseChange({actions}){
    const snap=await this.client.getData();const change=changeCustomExercises(snap.state,actions,await this.catalogue());
    return this.writer.prepare('custom_exercise',snap,change.state,change.details,change.result);
  }
  async applyCustomExerciseChange(input){return this.writer.commit('custom_exercise',input);}
  async listWorkouts(input={}){const snap=await this.client.getData();return listWorkouts(snap.state,input);}
  async getWorkout(input){const snap=await this.client.getData();return getWorkout(snap.state,input,await this.catalogue());}
  async getExerciseHistory(input){const snap=await this.client.getData();return exerciseHistory(snap.state,input,await this.catalogue());}
  async previewWorkoutEdit(input){
    const snap=await this.client.getData();const change=editWorkout(snap.state,input,await this.catalogue());
    return this.writer.prepare('workout_edit',snap,change.state,change.details,change.result);
  }
  async applyWorkoutEdit(input){return this.writer.commit('workout_edit',input);}
}
