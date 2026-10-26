import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,catalogue,setup,approve} from './fixtures.mjs';
import {analyse} from '../src/v040.mjs';
import {publicPlan,applyActions} from '../src/plan.mjs';
import {publicEntry} from '../src/workout-data.mjs';
import {weightsForEntry,defaultMuscleWeights} from '../src/muscle-weights.mjs';
import {editWorkout} from '../src/workout-edit.mjs';
const summary=(s,c=catalogue)=>analyse(s,{from:'1999-12-27',to:'2000-01-16'},c,true);
const rowIds=['0167','0193','0208','0236','0239','0571','0588','1313','1318','1320','1321','1323','1324','1350','3200'];
const weights={'upper-back':1,biceps:.4,chest:0,triceps:0}; // Synthetic contract, not copied exercise rows.
for(const id of rowIds)test('Synthetic corrected row '+id+' gives no chest/triceps effective load',()=>{
 const s=fixture();s.workouts[0].entries=[{id,muscleSnapshot:{primaries:['chest'],secondaries:['triceps']},sets:[
  {w:2,r:3,done:true},{w:20,r:20,done:true,phase:'warmup'},{w:20,r:20,done:false},
  {done:false,sides:{L:{w:3,r:4,done:true},R:{w:99,r:99,done:false}}}]}];
 const c={names:{},exercises:{[id]:{id,primaries:['upper-back'],secondaries:['chest','triceps'],muscleWeights:weights}}};
 const before=structuredClone(s),r=summary(s,c).weeks[0];assert.equal(r.completed_work_sets,2);assert.equal(r.volume_by_weight_basis.as_recorded,18);
 assert.equal(r.muscles['upper-back'].effective_sets,2);assert.equal(r.muscles.biceps.effective_sets,.8);
 assert.equal(r.muscles.chest.effective_sets,0);assert.equal(r.muscles.triceps.effective_sets,0);
 assert.equal(r.muscles.chest.primary_sets,2);assert.equal(r.muscle_weight_sources.catalogue_explicit,2);assert.deepEqual(s,before);
});
test('Valid historical weights, including old positive chest and explicit all-zero maps, remain authoritative',()=>{
 const s=fixture(),c=structuredClone(catalogue);c.exercises.a.muscleWeights=weights;
 s.workouts[0].entries[0].muscleSnapshot={primaries:['chest'],muscleWeights:{chest:.25,triceps:0}};
 const r=summary(s,c).weeks[0];assert.equal(r.muscles.chest.effective_sets,.25);assert.equal(r.muscles.triceps.effective_sets,0);assert.equal(r.muscles['upper-back'],undefined);
 assert.equal(r.muscle_weight_sources.snapshot_explicit,1);
 s.workouts[0].entries[0].muscleSnapshot.muscleWeights={chest:0};const zero=summary(s,c).weeks[0];assert.equal(zero.muscles.chest.effective_sets,0);assert.equal(zero.effective_unmapped_sets,0);
});
for(const invalid of [{},{chest:-1},{chest:'1'},{chest:null},{chest:2},{chest:NaN},{chest:Infinity},[]])
 test('Missing or invalid historical weights fall back without modifying history: '+JSON.stringify(invalid),()=>{
  const s=fixture(),c=structuredClone(catalogue);c.exercises.a.muscleWeights=weights;s.workouts[0].entries[0].muscleSnapshot.muscleWeights=invalid;
  const before=structuredClone(s),r=summary(s,c).weeks[0];assert.equal(r.muscles['upper-back'].effective_sets,1);assert.equal(r.muscles.chest.effective_sets,0);assert.deepEqual(s,before);
 });
test('Explicit historical entry weights and custom catalogue precedence are preserved',()=>{
 const e={id:'a',exercise:{muscleWeights:{biceps:.2}}};assert.equal(weightsForEntry(fixture(),catalogue,e).source,'entry_explicit');
 const s=fixture();s.customEx=[{id:'a',primaries:['abs'],secondaries:['obliques']}];assert.deepEqual(weightsForEntry(s,catalogue,{id:'a'}).weights,{abs:1,obliques:.4});
 assert.deepEqual(weightsForEntry({customEx:[]},{},{id:'gone',muscleSnapshot:{primaries:['abs'],secondaries:['obliques']}}),{weights:{abs:1,obliques:.4},source:'snapshot_default'});
});
test('Default weights canonicalize legacy aliases, deduplicate and use body-part fallback',()=>{
 assert.deepEqual(defaultMuscleWeights({tg:'pectorals',sm:['chest','triceps','triceps','hands']}),{chest:1,triceps:.4});
 assert.deepEqual(defaultMuscleWeights({primaries:['lats'],secondaries:['upper back','biceps']}),{'upper-back':1,biceps:.4});
 assert.deepEqual(defaultMuscleWeights({bp:'back'}),{'upper-back':.75,'lower-back':.25});
});
test('Additive effective fields retain old totals, empty weeks and deletion/Undo semantics',()=>{
 const s=fixture();let r=summary(s).weeks;assert.equal(r[0].muscles.chest.effective_sets,1);assert.equal(r[0].completed_work_sets,1);
 assert.deepEqual(r[1].muscles,{});assert.equal(r[1].change_from_previous_week.completed_work_sets,-1);
 s.deleted={workouts:{w1:2}};assert.equal(summary(s).weeks[0].workouts,0);s.deleted.workouts.w1=-3;assert.equal(summary(s).weeks[0].muscles.chest.effective_sets,1);
});
const extras={subs:['b','t'],warmupRestSec:30,warmupRestOff:false,sideRestSec:10};
function stateWithExtras(){const s=fixture();Object.assign(s.routines[0].ex[0],extras);s.barDefaults={kg:{barbell:15},lb:{barbell:35}};s.dayPhotos={['a'.repeat(64)]:{d:'2000-01-01',m:{kind:'image',hash:'a'.repeat(64),mime:'image/jpeg',size:10,width:1,height:1,at:1},_ts:5},cleared:{_ts:7}};return s;}
test('get_plan and workout target expose optional native configs without fabricating defaults',()=>{
 const s=stateWithExtras(),p=publicPlan(s),e=p.routines[0].exercises[0];for(const k of Object.keys(extras))assert.deepEqual(e[k],extras[k]);
 assert.deepEqual(publicEntry({id:'a',target:extras,sets:[]},0,s,catalogue).target,extras);
 const old=publicPlan(fixture()).routines[0].exercises[0];for(const k of Object.keys(extras))assert.equal(Object.hasOwn(old,k),false);
});
test('Plan rename/targets/reorder/same-ID replacement preserve new configs, roots and photos',async()=>{
 const s=stateWithExtras(),x=setup();x.client.data=structuredClone(s);const before=structuredClone(s);
 const p=await x.bridge.preview({actions:[{type:'rename_routine',routine_id:'r',name:'Synthetic renamed'},
 {type:'set_exercise_target',routine_id:'r',exercise_index:0,sets:3},{type:'add_routine_exercise',routine_id:'r',exercise:{exercise_id:'b',sets:1,reps:3}},
 {type:'move_routine_exercise',routine_id:'r',exercise_index:0,to_index:1},
 {type:'replace_routine_exercise',routine_id:'r',exercise_index:1,exercise:{exercise_id:'a',sets:2,reps:6}}]});
 assert.equal((await x.bridge.apply(approve(p))).verified,true);const actual=x.client.data.routines[0].ex[1];for(const k of Object.keys(extras))assert.deepEqual(actual[k],extras[k]);
 assert.deepEqual(x.client.data.barDefaults,before.barDefaults);assert.deepEqual(x.client.data.dayPhotos,before.dayPhotos);assert.deepEqual(x.backups[0].snapshot.state,before);
});
for(const key of Object.keys(extras))test('Different-ID replacements refuse exercise-specific '+key,()=>{
 const s=fixture();s.routines[0].ex[0][key]=extras[key];assert.throws(()=>applyActions(s,[{type:'replace_routine_exercise',routine_id:'r',exercise_index:0,exercise:{exercise_id:'b',sets:1,reps:3}}],catalogue.names));
 s.workouts[0].entries[0].target[key]=extras[key];assert.throws(()=>editWorkout(s,{workout_id:'w1',actions:[{type:'replace_exercise',exercise_index:0,exercise:{exercise_id:'b',sets:[{weight:1,reps:3}]}}]},catalogue),e=>e.code==='unsupported');
});
test('Saved-workout set and note changes preserve snapshots, target config and new root data',()=>{
 const s=stateWithExtras();Object.assign(s.workouts[0].entries[0].target,extras);s.workouts[0].entries[0].muscleSnapshot.muscleWeights={chest:.2};
 const r=editWorkout(s,{workout_id:'w1',actions:[{type:'set_note',note:'Synthetic change'},{type:'update_set',exercise_index:0,set_index:0,changes:{reps:6}}]},catalogue).state;
 for(const k of Object.keys(extras))assert.deepEqual(r.workouts[0].entries[0].target[k],extras[k]);
 assert.deepEqual(r.workouts[0].entries[0].muscleSnapshot,s.workouts[0].entries[0].muscleSnapshot);assert.deepEqual(r.dayPhotos,s.dayPhotos);assert.deepEqual(r.barDefaults,s.barDefaults);
});
