// Reviewed milestone-1 routine editor, adapted to the existing guarded plan boundary.
import { PlanError } from './errors.mjs';
import { only,text,integer,number,isObject } from './validate.mjs';
export const ROUTINE_EDIT_TYPES=new Set(['rename_routine','add_routine_exercise','remove_routine_exercise','replace_routine_exercise','move_routine_exercise']);
const index=(n,len,label='exercise_index')=>integer(n,0,len-1,label);
const slot=(state,input,names)=>{
 only(input,['exercise_id','sets','reps','weight']);text(input.exercise_id,64,'exercise_id');
 if(!Object.hasOwn(names,input.exercise_id)&&!(state.customEx||[]).some(e=>e.id===input.exercise_id))throw new PlanError('Unknown exercise ID');
 return {id:input.exercise_id,sets:integer(input.sets,1,12,'sets'),reps:integer(input.reps,1,100,'reps'),weight:number(input.weight??0,0,1000,'weight')};
};
export function applyRoutineEditAction(state,a,names={}){
 const routine=(state.routines||[]).find(r=>r.id===a.routine_id);if(!routine||!Array.isArray(routine.ex))throw new PlanError('Unknown routine');
 const before=structuredClone(routine);const list=routine.ex;
 if(a.type==='rename_routine'){only(a,['type','routine_id','name']);routine.name=text(a.name,60,'name');}
 else if(a.type==='add_routine_exercise'){
  only(a,['type','routine_id','exercise','index']);if(list.length>=12)throw new PlanError('Maximum 12 exercises');const next=slot(state,a.exercise,names);
  if(list.some(e=>e.id===next.id))throw new PlanError('Duplicate exercise');list.splice(a.index===undefined?list.length:index(a.index,list.length+1,'index'),0,next);
 }else if(a.type==='remove_routine_exercise'){
  only(a,['type','routine_id','exercise_index']);if(list.length<=1)throw new PlanError('Cannot remove last exercise');list.splice(index(a.exercise_index,list.length),1);
 }else if(a.type==='move_routine_exercise'){
  only(a,['type','routine_id','exercise_index','to_index']);const i=index(a.exercise_index,list.length),j=index(a.to_index,list.length,'to_index');const [e]=list.splice(i,1);list.splice(j,0,e);
 }else if(a.type==='replace_routine_exercise'){
  only(a,['type','routine_id','exercise_index','exercise']);const i=index(a.exercise_index,list.length),old=list[i],next=slot(state,a.exercise,names);
  if(!isObject(old)||list.some((e,j)=>j!==i&&e.id===next.id))throw new PlanError('Invalid or duplicate replacement');
  // subs and warmup/side rest settings belong to this exercise: do not guess a migration.
  if(old.id!==next.id&&Object.keys(old).some(k=>!['id','sets','reps','weight','restSec'].includes(k)))throw new PlanError('Exercise configuration/extension fields cannot be safely migrated; replacement refused');
  list[i]=old.id===next.id?{...old,...next}:{...next,...(old.restSec===undefined?{}:{restSec:old.restSec})};
 }else throw new PlanError('Unknown routine edit');
 return JSON.stringify(before)===JSON.stringify(routine)?[]:[{type:a.type,routine_id:routine.id,before,after:structuredClone(routine)}];
}
