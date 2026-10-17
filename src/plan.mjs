import { randomUUID } from 'node:crypto';
import { normalizeWorkoutInput, workoutSignature, workoutPreview, verifyLoggedWorkout } from './workout-log.mjs';

export class PlanError extends Error {
  constructor(message, code = 'validation') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

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
            reps:s.r ?? null, weight:s.w ?? null, done:!!s.done,
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
  constructor({client, writes=false, now=Date.now, ttl=600000, loadNames=async()=>({})}){
    this.client=client;
    this.loadNames=loadNames;
    this.writes=writes;
    this.now=now;
    this.ttl=ttl;
    this.drafts=new Map();
    this.workoutDrafts=new Map();
    this.writing=false;
  }
  async getStatus(){
    const auth=await this.client.refreshLogin();
    const snap=await this.client.getData();
    return {connected:true,profile:auth.user?.name||'已连接',rev:snap.rev,has_state:!!snap.state,writes_enabled:this.writes};
  }
  async getPlan(){ const snap=await this.client.getData(); return {...publicPlan(snap.state,await this.loadNames()),server_revision:snap.rev}; }
  async searchExercises({query,limit=15}={}){
    if(typeof query!=='string'||!query.trim()||query.length>100) throw new PlanError('query 必须是 1-100 字的动作名称或 ID');
    boundedInt(limit,1,30,'limit');
    const names=await this.loadNames();
    if(!Object.keys(names).length) throw new PlanError('动作目录尚未加载；请在 Bridge 容器终端运行 node src/catalogue.mjs');
    const q=query.trim().toLocaleLowerCase();
    const results=Object.entries(names).filter(([id,name])=>id.toLowerCase()===q||String(name).toLocaleLowerCase().includes(q)).slice(0,limit).map(([exercise_id,exercise_name])=>({exercise_id,exercise_name}));
    return {query:query.trim(),count:results.length,results};
  }
  async getSummary(){const snap=await this.client.getData(); return {...publicSummary(snap.state),server_revision:snap.rev};}
  async getRecent({limit=10}={}){const snap=await this.client.getData(); return publicRecent(snap.state,limit,await this.loadNames());}
  async preview({actions}){
    const snap=await this.client.getData();
    const planned=applyActions(snap.state,actions,await this.loadNames());
    const changes=planned.changes;
    this.cleanDrafts();
    const id=randomUUID();
    const expiresAt=this.now()+this.ttl;
    this.drafts.set(id,{rev:snap.rev,wid:snap.state._wid||null,actions:clone(planned.normalizedActions),expiresAt});
    return {
      proposal_id:id,source_revision:snap.rev,expires_at:new Date(expiresAt).toISOString(),
      changes,write_ready:this.writes,
      warning:'这只是预览，没有修改 openGym。写入前必须获得用户明确确认。',
    };
  }
  cleanDrafts(){
    for(const [id,entry] of this.drafts) if(entry.expiresAt<this.now()) this.drafts.delete(id);
    for(const [id,entry] of this.workoutDrafts) if(entry.expiresAt<this.now()) this.workoutDrafts.delete(id);
    while(this.drafts.size>50) this.drafts.delete(this.drafts.keys().next().value);
    while(this.workoutDrafts.size>50) this.workoutDrafts.delete(this.workoutDrafts.keys().next().value);
  }
  async previewWorkoutLog({workouts}={}){
    const snap=await this.client.getData();
    if(!obj(snap.state)) throw new PlanError('openGym 训练状态不存在；请先在 App 中保存并同步一次');
    if(!Array.isArray(workouts)||workouts.length<1||workouts.length>10) throw new PlanError('workouts 必须包含 1-10 次训练；建议按日期分批导入');
    const names=await this.loadNames();
    const normalized=workouts.map(w=>normalizeWorkoutInput(w,{state:snap.state,names}));
    const existing=new Set((Array.isArray(snap.state.workouts)?snap.state.workouts:[]).map(workoutSignature));
    const batch=new Set();
    for(const w of normalized){
      const sig=workoutSignature(w);
      if(existing.has(sig)) throw new PlanError(`发现疑似重复历史记录：${w.d}「${w.name}」。没有生成预览；请先检查 openGym 历史记录`,'duplicate');
      if(batch.has(sig)) throw new PlanError(`本次批量导入中存在重复记录：${w.d}「${w.name}」。没有生成预览`,'duplicate');
      batch.add(sig);
    }
    this.cleanDrafts();
    const id=randomUUID(),expiresAt=this.now()+this.ttl;
    this.workoutDrafts.set(id,{rev:snap.rev,wid:snap.state._wid||null,workouts:structuredClone(normalized),signatures:normalized.map(workoutSignature),expiresAt});
    const records=normalized.map(w=>workoutPreview(w,snap.state,names));
    return {proposal_id:id,source_revision:snap.rev,expires_at:new Date(expiresAt).toISOString(),workout_count:records.length,total_exercises:records.reduce((n,w)=>n+w.exercise_count,0),total_sets:records.reduce((n,w)=>n+w.set_count,0),records,write_ready:this.writes,warning:'这是训练历史写入预览，没有修改 openGym。确认前请逐条核对日期、动作、重量和次数。写入需要明确回复「我确认写入」。'};
  }
  async logWorkout({proposal_id,confirmation}){
    if(!this.writes) throw new PlanError('服务器未启用 OPENGYM_ALLOW_WRITES=1；此版本当前只能预览','write-disabled');
    if(confirmation!=='我确认写入') throw new PlanError('需要用户明确确认后，confirmation 才能填写「我确认写入」','approval-required');
    if(this.writing) throw new PlanError('另一笔写入正在执行，请稍后重试','busy');
    if(typeof proposal_id!=='string') throw new PlanError('缺少 proposal_id');
    const proposal=this.workoutDrafts.get(proposal_id);
    if(!proposal||proposal.expiresAt<this.now()) throw new PlanError('历史记录预览不存在或已过期，请重新预览','expired');
    this.writing=true;
    try{
      const current=await this.client.getData();
      if(current.rev!==proposal.rev||(current.state?._wid||null)!==proposal.wid){
        this.workoutDrafts.delete(proposal_id);
        throw new PlanError('检测到手机、网页或其他工具已更新训练数据；拒绝覆盖，请重新读取和预览','conflict');
      }
      const state=structuredClone(current.state);
      state.workouts=Array.isArray(state.workouts)?state.workouts:[];
      const existing=new Set(state.workouts.map(workoutSignature));
      for(let i=0;i<proposal.workouts.length;i++){
        if(existing.has(proposal.signatures[i])) throw new PlanError('写入前发现相同的训练历史已存在；为避免重复，整批未写入','duplicate');
        existing.add(proposal.signatures[i]);
      }
      state.workouts.push(...structuredClone(proposal.workouts));
      const response=await this.client.putData({state,baseRev:current.rev,baseWid:proposal.wid});
      this.workoutDrafts.delete(proposal_id);
      const after=await this.client.getData();
      const logged=proposal.workouts.map(expected=>(after.state?.workouts||[]).find(w=>w?.id===expected.id));
      const verified=logged.length===proposal.workouts.length&&logged.every((actual,i)=>verifyLoggedWorkout(actual,proposal.workouts[i]));
      return {applied:!!response.ok,verified,revision:after.rev,logged_count:proposal.workouts.length,records:proposal.workouts.map((w,i)=>({date:w.d,name:w.name,workout_id:w.id,verified:verifyLoggedWorkout(logged[i],w)})),...(verified?{}:{warning:'服务器接受了保存，但重新读取未看到全部期望值；不要重复导入，请先核对 App 历史记录。'})};
    }catch(error){
      if(error?.status===409){this.workoutDrafts.delete(proposal_id);throw new PlanError('openGym 返回 409：手机或网页刚刚写入了新版本，整批历史记录未自动重试','conflict');}
      throw error;
    }finally{this.writing=false;}
  }
  async apply({proposal_id,confirmation}){
    if(!this.writes) throw new PlanError('服务器未启用 OPENGYM_ALLOW_WRITES=1；此版本当前只能预览','write-disabled');
    if(confirmation!=='我确认写入') throw new PlanError('需要用户明确确认后，confirmation 才能填写「我确认写入」','approval-required');
    if(this.writing) throw new PlanError('另一笔写入正在执行，请稍后重试','busy');
    if(typeof proposal_id !== 'string') throw new PlanError('缺少 proposal_id');
    const proposal=this.drafts.get(proposal_id);
    if(!proposal || proposal.expiresAt<this.now()) throw new PlanError('预览不存在或已经超过十分钟，请重新预览','expired');
    this.writing=true;
    try {
      const current=await this.client.getData();
      if(current.rev!==proposal.rev || (current.state?._wid||null)!==proposal.wid){
        this.drafts.delete(proposal_id);
        throw new PlanError('检测到其他设备已经更新了训练数据；拒绝覆盖，请重新读取和预览','conflict');
      }
      const {state,changes}=applyActions(current.state,proposal.actions,await this.loadNames());
      const response=await this.client.putData({state,baseRev:current.rev,baseWid:proposal.wid});
      this.drafts.delete(proposal_id);
      const after=await this.client.getData();
      const verified=changes.every(change=>{
        if(change.type==='create_routine') {
          const routine=(after.state.routines||[]).find(r=>r.id===change.routine_id);
          return !!routine && routine.name===change.name && routine.ex?.length===change.exercises.length && change.exercises.every((ex,i)=>routine.ex[i]?.id===ex.exercise_id && routine.ex[i]?.sets===ex.sets && routine.ex[i]?.reps===ex.reps && routine.ex[i]?.weight===ex.weight);
        }
        if(change.type==='assign_weekday') return (after.state.week?.[change.weekday]||null)===change.to;
        if(change.type==='override_date') return (after.state.dayPlan?.[change.date]||null)===change.to;
        if(change.type==='set_exercise_target') {
          const routine=(after.state.routines||[]).find(r=>r.id===change.routine_id);
          const ex=routine?.ex?.[change.exercise_index];
          return ex?.id===change.exercise_id && Object.entries(change.to).every(([key,val])=>ex?.[key]===val);
        }
        return false;
      });
      return {
        applied:!!response.ok,verified,revision:after.rev,changes,
        ...(verified?{}:{warning:'服务器接受了保存，但重新读取未看到全部期望值：不要重复写入，请先核对 App 显示。'})
      };
    } catch(error){
      if(error?.status===409){ this.drafts.delete(proposal_id); throw new PlanError('openGym 返回 409：手机或网页刚刚写入了新版本，已拒绝覆盖','conflict'); }
      throw error;
    } finally {this.writing=false;}
  }
}
