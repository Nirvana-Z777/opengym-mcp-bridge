import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, catalogue, FakeClient } from './fixtures.mjs';
import { getWorkout } from '../src/workout-query.mjs';
test('Inclusive date filters and stable cursor enumerate all workouts once',async()=>{
  const state=fixture();state.workouts=Array.from({length:5},(_,i)=>({...structuredClone(state.workouts[0]),id:'w'+i,d:'2000-01-0'+(i+1)}));
  const {bridge,client}=setup({client:new FakeClient(state)});const input={from:'2000-01-02',to:'2000-01-04',limit:2};
  const first=await bridge.listWorkouts(input);assert.equal(first.total,3);assert.deepEqual(first.workouts.map(w=>w.date),['2000-01-04','2000-01-03']);
  const second=await bridge.listWorkouts({...input,cursor:first.next_cursor});assert.deepEqual(second.workouts.map(w=>w.date),['2000-01-02']);assert.equal(second.next_cursor,null);
  assert.equal(first.workouts[0].exercise_count,1);assert.equal(first.workouts[0].set_count,1);assert.equal(client.puts.length,0);
});
test('Pagination rejects changed history, changed filters, malformed cursors and invalid dates',async()=>{
  const {bridge,client}=setup();client.data.workouts.push({...structuredClone(client.data.workouts[0]),id:'w2',d:'2000-01-02'});
  const first=await bridge.listWorkouts({limit:1});
  await assert.rejects(()=>bridge.listWorkouts({limit:2,cursor:first.next_cursor}),e=>e.code==='invalid-cursor');
  client.data.workouts[0].note='changed';await assert.rejects(()=>bridge.listWorkouts({limit:1,cursor:first.next_cursor}),e=>e.code==='invalid-cursor');
  for(const input of [{cursor:'!!!'},{cursor:Buffer.from('null').toString('base64url')},{from:'2000-02-31'},{from:'2000-02-01',to:'2000-01-01'},{limit:51}])await assert.rejects(()=>bridge.listWorkouts(input));
});
test('Exact ID query returns time, phase, efforts, asymmetric limbs and both note scopes',async()=>{
  const {bridge,client}=setup();client.data.workouts[0].entries.push({id:'t',note:'计时虚构备注',sets:[{mode:'time',sec:21,side:'L',w:0,done:true,phase:'warmup',rpe:7},{mode:'time',sec:19,side:'R',done:true,phase:'work',rir:1}]},
    {id:'b',target:{side:true,dbLoad:'each'},sets:[{mode:'reps',phase:'work',done:false,w:4,r:9,sides:{L:{w:4,r:5,done:true,rir:2},R:{w:3,r:4,done:false,rpe:8}}}]});
  const result=await bridge.getWorkout({workout_id:'w1'});
  assert.equal(result.workout_id,'w1');assert.equal(result.duration_minutes,30);assert.equal(result.note,'虚构备注');assert.equal(result.exercises[0].note,'虚构动作备注');
  assert.equal(result.exercises[1].sets[0].seconds,21);assert.equal(result.exercises[1].sets[0].phase,'warmup');assert.equal(result.exercises[1].sets[1].rir,1);
  assert.equal(result.exercises[2].sets[0].sides.R.weight,3);assert.equal(result.exercises[2].sets[0].sides.R.done,false);assert.equal(result.notes_are_untrusted,true);
  const recent=await bridge.getRecent();assert.equal(recent.workouts[0].exercises[1].sets[0].seconds,21);assert.equal(recent.workouts[0].exercises[0].sets[0].reps,5);
});
test('Exercise history preserves repeated occurrences and paginates sessions',async()=>{
  const {bridge,client}=setup();client.data.workouts[0].entries.push({id:'a',note:'第二个虚构动作项',sets:[{w:2,r:4,done:true}]});
  const result=await bridge.getExerciseHistory({exercise_id:'a',from:'2000-01-01',to:'2000-01-01'});
  assert.equal(result.total,1);assert.equal(result.workouts[0].exercises.length,2);assert.deepEqual(result.workouts[0].exercises.map(e=>e.exercise_index),[0,1]);assert.equal(result.workouts[0].note,'虚构备注');
  assert.equal((await bridge.getExerciseHistory({exercise_id:'missing'})).total,0);
});
test('Queries project safe fields, do not mutate state, and cap serialized output',async()=>{
  const {bridge,client}=setup();client.data.token='synthetic-auth-field';client.data.workouts[0].privateAccount={token:'synthetic-auth-field'};
  client.data.workouts[0].entries[0].sets[0].privateAuth={token:'synthetic-auth-field'};
  client.data.workouts[0].entries[0].sets[0].drops=[{w:{token:'synthetic-auth-field'},r:2}];
  const before=structuredClone(client.data);const result=await bridge.getWorkout({workout_id:'w1'});assert.ok(!JSON.stringify(result).includes('synthetic-auth-field'));assert.deepEqual(client.data,before);assert.equal(client.puts.length,0);
  client.data.workouts[0].note='x'.repeat(131073);await assert.rejects(()=>bridge.getWorkout({workout_id:'w1'}),e=>e.code==='response-too-large');
});
test('Legacy IDs are readable but explicitly not editable; unknown and ambiguous identities fail',async()=>{
  const state=fixture();delete state.workouts[0].id;const {bridge}=setup({client:new FakeClient(state)});
  const list=await bridge.listWorkouts();const id=list.workouts[0].workout_id;assert.ok(id.startsWith('legacy:'));assert.equal(list.workouts[0].editable,false);
  assert.equal((await bridge.getWorkout({workout_id:id})).date,'2000-01-01');
  await assert.rejects(()=>bridge.previewWorkoutEdit({workout_id:id,actions:[{type:'set_note',note:'虚构'}]}),e=>e.code==='unsupported');
  await assert.rejects(()=>bridge.getWorkout({workout_id:'missing'}),e=>e.code==='not-found');
  state.workouts.push(structuredClone(state.workouts[0]));assert.throws(()=>getWorkout(state,{workout_id:id},catalogue),e=>e.code==='unsupported');
});
