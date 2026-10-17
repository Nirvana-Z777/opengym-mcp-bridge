import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalGymBridge } from '../src/plan.mjs';
import { dispatch, listTools } from '../src/mcp.mjs';
// All identities, pairing codes, body weights, dates, and per-set values in this file are fictional test fixtures and are not from any user.

const fixture=()=>({
  _rev:10,_wid:'rev-10-write-id',_ts:946684800000,
  unit:'kg',routines:[],week:{},dayPlan:{},bodyweight:[],
  workouts:[{id:'old-1',d:'2000-01-04',name:'Synthetic routine A',entries:[{id:'0293',sets:[{w:2.5,r:6,done:true,rir:2}]}]}],
  keepMe:'must remain',
});
class FakeClient{
  constructor(){this.rev=10;this.data=fixture();this.beforePut=null;}
  async refreshLogin(){return {user:{name:'test'}};}
  async getData(){return {rev:this.rev,state:structuredClone(this.data)};}
  async putData({state,baseRev,baseWid}){
    if(baseRev!==this.rev||baseWid!==this.data._wid){const e=new Error('conflict');e.status=409;throw e;}
    this.beforePut=structuredClone(state);this.rev++;
    this.data={...structuredClone(state),_rev:this.rev,_wid:'new-write-id-'+this.rev};
    return {ok:true,rev:this.rev};
  }
}
const names={'0025':'杠铃卧推','0293':'哑铃划船','1128':'悬挂带俯卧撑','1470':'侧向侧平板支撑'};
const workoutA={date:'2000-01-03',name:'Synthetic workout A',exercises:[
  {exercise_id:'0025',sets:[{weight:1,reps:5},{weight:1,reps:4,rir:2}]},
  {exercise_id:'1128',sets:[{weight:0,reps:3},{weight:0,reps:2}]},
]};

test('Workout history preview is read-only and returns exact per-set preview',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({client,writes:true,loadNames:async()=>names});
  const p=await bridge.previewWorkoutLog({workouts:[workoutA]});
  assert.equal(p.workout_count,1);
  assert.equal(p.total_exercises,2);
  assert.equal(p.total_sets,4);
  assert.equal(p.records[0].date,'2000-01-03');
  assert.equal(p.records[0].exercises[0].sets[1].rir,2);
  assert.equal(client.data.workouts.length,1);
  assert.equal(client.beforePut,null);
});

test('Approved batch history write appends only workouts and verifies after reread',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({client,writes:true,loadNames:async()=>names});
  const second={date:'2000-01-01',name:'Synthetic workout B',exercises:[{exercise_id:'0293',sets:[{weight:2.5,reps:6},{weight:2.5,reps:5}]}]};
  const p=await bridge.previewWorkoutLog({workouts:[workoutA,second]});
  await assert.rejects(()=>bridge.logWorkout({proposal_id:p.proposal_id,confirmation:'approve'}),/确认/);
  const result=await bridge.logWorkout({proposal_id:p.proposal_id,confirmation:'我确认写入'});
  assert.equal(result.applied,true);
  assert.equal(result.verified,true);
  assert.equal(result.logged_count,2);
  assert.equal(client.data.workouts.length,3);
  assert.equal(client.data.workouts[1].d,'2000-01-03');
  assert.equal(client.data.workouts[1].entries[0].sets[0].w,1);
  assert.equal(client.data.workouts[1].entries[1].sets[0].done,true);
  assert.equal(client.data.routines.length,0);
  assert.deepEqual(client.data.bodyweight,[]);
  assert.equal(client.data.keepMe,'must remain');
  assert.equal(client.beforePut._wid,'rev-10-write-id');
  await assert.rejects(()=>bridge.logWorkout({proposal_id:p.proposal_id,confirmation:'我确认写入'}),/不存在或已过期/);
});

test('Duplicate workout history is rejected before preview and batch remains atomic',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({client,writes:true,loadNames:async()=>names});
  const duplicate={date:'2000-01-04',name:'Synthetic routine A',exercises:[{exercise_id:'0293',sets:[{weight:2.5,reps:6,rir:2}]}]};
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[duplicate]}),/疑似重复/);
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[workoutA,workoutA]}),/批量导入中存在重复/);
  assert.equal(client.data.workouts.length,1);
  assert.equal(client.beforePut,null);
});

test('Reject unknown exercise IDs, invented durations, and invalid dates',async()=>{
  const bridge=new PersonalGymBridge({client:new FakeClient(),writes:true,loadNames:async()=>names});
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[{...workoutA,date:'2000-02-31'}]}),/有效日期/);
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[{...workoutA,duration_minutes:40}]}),/只有知道 started_at/);
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[{...workoutA,exercises:[{exercise_id:'bad-id',sets:[{weight:1,reps:3}]}]}]}),/不在 openGym 动作目录/);
});

test('Stale revision refuses to append the batch',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({client,writes:true,loadNames:async()=>names});
  const p=await bridge.previewWorkoutLog({workouts:[workoutA]});
  client.rev++;
  client.data._wid='changed-elsewhere';
  await assert.rejects(()=>bridge.logWorkout({proposal_id:p.proposal_id,confirmation:'我确认写入'}),/拒绝覆盖/);
  assert.equal(client.beforePut,null);
  assert.equal(client.data.workouts.length,1);
});


test('Timed holds preserve actual seconds without inventing repetitions or volume',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({client,writes:true,loadNames:async()=>names});
  const timed={date:'2000-01-02',name:'Synthetic timed workout',exercises:[
    {exercise_id:'1470',sets:[{seconds:20},{seconds:15,weight:0}]},
  ]};
  const p=await bridge.previewWorkoutLog({workouts:[timed]});
  assert.equal(p.records[0].exercises[0].sets[0].seconds,20);
  assert.equal(p.records[0].exercises[0].sets[0].reps,undefined);
  assert.equal(p.records[0].volume,0);
  const result=await bridge.logWorkout({proposal_id:p.proposal_id,confirmation:'我确认写入'});
  assert.equal(result.verified,true);
  assert.equal(client.data.workouts[1].entries[0].sets[0].sec,20);
  assert.equal(client.data.workouts[1].entries[0].sets[0].r,undefined);
});

test('Timed set requires seconds or reps, never both or neither',async()=>{
  const bridge=new PersonalGymBridge({client:new FakeClient(),writes:true,loadNames:async()=>names});
  const base={date:'2000-01-02',name:'Synthetic timed workout',exercises:[{exercise_id:'1470',sets:[{seconds:20}]}]};
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[{...base,exercises:[{exercise_id:'1470',sets:[{seconds:20,reps:1}]}]}]}),/必须且只能填写/);
  await assert.rejects(()=>bridge.previewWorkoutLog({workouts:[{...base,exercises:[{exercise_id:'1470',sets:[{weight:0}]}]}]}),/必须且只能填写/);
});

test('Write tool is hidden when writes are disabled; preview remains available',async()=>{
  const bridge=new PersonalGymBridge({client:new FakeClient(),writes:false,loadNames:async()=>names});
  const tools=listTools(false).map(t=>t.name);
  assert.ok(tools.includes('preview_workout_log'));
  assert.ok(!tools.includes('log_workout'));
  assert.ok(listTools(true).some(t=>t.name==='log_workout'));
  const p=await bridge.previewWorkoutLog({workouts:[workoutA]});
  await assert.rejects(()=>bridge.logWorkout({proposal_id:p.proposal_id,confirmation:'我确认写入'}),/未启用/);
  const reply=await dispatch({jsonrpc:'2.0',id:7,method:'tools/list'},bridge);
  assert.ok(reply.result.tools.some(t=>t.name==='preview_workout_log'));
  assert.ok(!reply.result.tools.some(t=>t.name==='log_workout'));
});
