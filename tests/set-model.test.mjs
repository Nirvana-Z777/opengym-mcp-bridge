import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approve, catalogue, fixture } from './fixtures.mjs';
import { normalizeSet, normalizeEntry, workoutVolume, bestLoad, patchSet } from '../src/workout-data.mjs';
test('Asymmetric unilateral reps are stored as independent limbs with accurate scalar mirrors and volume',async()=>{
  const {bridge,client}=setup();const p=await bridge.previewWorkoutLog({workouts:[{date:'2000-02-01',name:'Synthetic unilateral',note:'虚构训练备注',exercises:[{exercise_id:'b',weight_basis:'per_dumbbell',note:'虚构动作备注',sets:[
    {phase:'warmup',sides:{L:{weight:9,reps:3},R:{weight:7,reps:2}}},
    {phase:'work',sides:{L:{weight:4,reps:5,rir:2},R:{weight:3,reps:4,rpe:8}}},
    {sides:{L:{weight:2,reps:3,done:true},R:{weight:5,reps:6,done:false}}},
  ]}]}]});
  assert.equal(p.records[0].volume,38);await bridge.logWorkout(approve(p));const w=client.data.workouts.find(w=>w.d==='2000-02-01');const row=w.entries[0].sets[1];
  assert.equal(row.r,9);assert.equal(row.w,4);assert.equal(row.done,true);assert.equal(row.rir,2);assert.equal(row.rpe,undefined);assert.equal(w.entries[0].sets[2].done,false);
  assert.equal(w.entries[0].target.side,true);assert.equal(w.entries[0].target.dbLoad,'each');assert.equal(w.entries[0].topW,4);
  const q=await bridge.previewWorkoutEdit({workout_id:w.id,actions:[{type:'update_set',exercise_index:0,set_index:1,changes:{sides:{R:{weight:2,reps:3,rir:1}}}}]});
  assert.equal(q.after.volume,32);await bridge.applyWorkoutEdit(approve(q));const read=await bridge.getWorkout({workout_id:w.id});assert.equal(read.exercises[0].sets[1].sides.R.reps,3);assert.equal(read.exercises[0].sets[1].sides.R.rpe,undefined);assert.equal(read.note,'虚构训练备注');
});
test('Unilateral timed holds remain separate left/right flat rows and preserve seconds',async()=>{
  const {bridge,client}=setup();const p=await bridge.previewWorkoutLog({workouts:[{date:'2000-02-02',name:'Synthetic side holds',exercises:[{exercise_id:'t',sets:[{seconds:18,side:'L',phase:'work'},{seconds:16,side:'R',phase:'work'}]}]}]});
  await bridge.logWorkout(approve(p));const w=client.data.workouts.find(w=>w.d==='2000-02-02');assert.equal(w.entries[0].sets.length,2);assert.equal(w.entries[0].sets[0].sides,undefined);assert.equal(w.vol,0);
  const read=await bridge.getWorkout({workout_id:w.id});assert.equal(read.exercises[0].sets[1].seconds,16);assert.equal(read.exercises[0].sets[1].side,'R');
});
test('Three dumbbell meanings retain identical stored weights while volume follows explicit native meaning',()=>{
  for(const [basis,expected] of [['as_recorded',12],['per_dumbbell',24],['pair_total',12]]){
    const e=normalizeEntry({exercise_id:'a',weight_basis:basis,sets:[{weight:3,reps:4}]},{state:fixture(),catalogue});
    assert.equal(e.sets[0].w,3);assert.equal(workoutVolume({entries:[e]},fixture(),catalogue),expected);
  }
  const state=fixture();state.dbLoad={a:{mode:'each'}};assert.equal(workoutVolume(state.workouts[0],state,catalogue),25);assert.equal(state.workouts[0].entries[0].sets[0].w,5);
});
test('Editing reps preserves old weights and meaning; adding a unilateral each row cannot reinterpret old volume',async()=>{
  const {bridge,client}=setup();client.data.workouts[0].entries[0].target.dbLoad='each';
  const p=await bridge.previewWorkoutEdit({workout_id:'w1',actions:[{type:'update_set',exercise_index:0,set_index:0,changes:{reps:4}}]});await bridge.applyWorkoutEdit(approve(p));
  assert.equal(client.data.workouts[0].entries[0].sets[0].w,5);assert.equal(client.data.workouts[0].entries[0].target.dbLoad,'each');assert.equal(client.data.workouts[0].vol,40);
  await assert.rejects(()=>bridge.previewWorkoutEdit({workout_id:'w1',actions:[{type:'add_set',exercise_index:0,set:{sides:{L:{weight:2,reps:3},R:{weight:2,reps:3}}}}]}),e=>e.code==='unsupported');
});
test('Effort values and unilateral inputs are validated without inventing a missing limb',()=>{
  for(const input of [{reps:2,rir:2,rpe:8},{seconds:2,reps:1},{sides:{L:{weight:2,reps:3}}},{reps:3,side:'L'},{reps:3,rpe:5},{seconds:0},{reps:0},{reps:3,weight:NaN}])assert.throws(()=>normalizeSet(input));
  const original={w:2,r:3,done:true,rpe:8,opaque:'preserve'};assert.deepEqual(patchSet(original,{weight:2}),original);
  const changed=patchSet(original,{seconds:20,rir:2});assert.equal(changed.r,undefined);assert.equal(changed.rpe,undefined);assert.equal(changed.sec,20);assert.equal(changed.opaque,'preserve');
});
test('Legacy warmup marker, zero work loads, drops and rest-pause metrics follow native semantics',()=>{
  const e={id:'a',topW:50,sets:[{w:30,r:10,done:true,warmup:true},{w:0,r:5,done:true,phase:'work'},{w:4,r:5,done:true,type:'dropset',drops:[{w:2,r:3}]},{w:3,r:6,done:true,type:'restpause',clusters:[{r:4},{r:2}]}]};
  assert.equal(workoutVolume({entries:[e]},fixture(),catalogue),44);assert.equal(bestLoad(e,fixture(),catalogue),4);
  assert.equal(bestLoad({id:'a',topW:50,sets:[{w:0,r:5,done:true}]},fixture(),catalogue),0);
  assert.equal(bestLoad({id:'a',target:{mode:'time'},topW:50,sets:[]},fixture(),catalogue),0);
});
