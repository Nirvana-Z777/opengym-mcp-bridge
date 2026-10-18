import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalGymBridge, applyActions, publicPlan, publicRecent } from '../src/plan.mjs';
import { dispatch, listTools, createHttpServer } from '../src/mcp.mjs';
// All identities, pairing codes, body weights, dates, and per-set values in this file are fictional test fixtures and are not from any user.

const fixture=() => ({
  _rev:4,_wid:'0123456789abcdef',_ts:946684800000,
  routines:[{id:'r-A',name:'Synthetic routine A',ex:[{id:'0025',sets:3,reps:5,weight:1,restSec:80},{id:'0293',sets:3,reps:6,weight:2.5}]}],
  week:{'1':'r-A'},dayPlan:{},bodyweight:[{d:'2000-01-02',w:60,t:946684800000}],
  workouts:[{id:'w1',d:'2000-01-04',name:'Synthetic routine A',start:946684800000,end:946686600000,
    entries:[{id:'0293',sets:[{w:2.5,r:6,done:true,rir:2}]}]}],unit:'kg',
  keepMe:'untouched',
  edited:{'week.1':946684800000},
});

class FakeClient {
  constructor(){this.rev=4;this.data=fixture();this.beforePut=null;this.requestCount=0;}
  async refreshLogin(){return {user:{name:'test'}};}
  async getData(){this.requestCount++;return {rev:this.rev,state:structuredClone(this.data)};}
  async putData({state,baseRev,baseWid}){
    if(baseRev!==this.rev || baseWid!==this.data._wid){const err=new Error('conflict');err.status=409;throw err;}
    this.beforePut={state:structuredClone(state),baseRev,baseWid};
    this.rev++;
    this.data={...structuredClone(state),_rev:this.rev,_wid:'9876543210abcdef'};
    return {ok:true,rev:this.rev};
  }
}

test('Plan view includes exercise indices and exact IDs',()=>{
  const plan=publicPlan(fixture());
  assert.equal(plan.routines[0].exercises[1].exercise_index,1);
  assert.equal(plan.routines[0].exercises[1].exercise_id,'0293');
  assert.equal(plan.week[1],'r-A');
});

test('Recent workout data is bounded and includes sets',()=>{
  const data=publicRecent(fixture(),1);
  assert.equal(data.workouts.length,1);
  assert.equal(data.workouts[0].exercises[0].sets[0].rir,2);
  assert.throws(()=>publicRecent(fixture(),100));
});

test('Plan changes copy state and retain unrelated data',()=>{
  const original=fixture();
  const {state,changes}=applyActions(original,[
    {type:'assign_weekday',weekday:3,routine_id:'r-A'},
    {type:'override_date',date:'2000-01-05',routine_id:'rest'},
    {type:'set_exercise_target',routine_id:'r-A',exercise_index:1,sets:4,reps:5,weight:3},
  ]);
  assert.equal(changes.length,3);
  assert.equal(state.week[3],'r-A');
  assert.equal(state.dayPlan['2000-01-05'],'rest');
  assert.equal(state.routines[0].ex[1].weight,3);
  assert.equal(state.routines[0].ex[0].restSec,80);
  assert.equal(state.keepMe,'untouched');
  assert.equal(original.week[3],undefined);
  assert.equal(original.routines[0].ex[1].weight,2.5);
});

test('Create a new routine with validated exercise IDs and optional weekday assignments',()=>{
  const original=fixture();
  const names={'0025':'杠铃卧推','0293':'哑铃划船'};
  const planned=applyActions(original,[{type:'create_routine',name:'推日',emoji:'barbell',exercises:[{exercise_id:'0025',sets:3,reps:3,weight:5},{exercise_id:'0293',sets:3,reps:5,weight:4}],weekdays:[1,4]}],names);
  const created=planned.state.routines.at(-1);
  assert.equal(created.name,'推日');
  assert.equal(created.ex.length,2);
  assert.equal(created.ex[0].id,'0025');
  assert.equal(created.ex[0].weight,5);
  assert.equal(planned.state.week[1],created.id);
  assert.equal(planned.state.week[4],created.id);
  assert.equal(planned.changes[0].type,'create_routine');
  assert.equal(planned.normalizedActions[0].id,created.id);
  const replay=applyActions(original,planned.normalizedActions,names);
  assert.equal(replay.state.routines.at(-1).id,created.id);
  assert.equal(replay.state.week[4],created.id);
  assert.equal(original.routines.length,1);
});

test('Reject invalid or unknown exercises when creating routines',()=>{
  const names={'0025':'杠铃卧推'};
  assert.throws(()=>applyActions(fixture(),[{type:'create_routine',name:'推日',exercises:[{exercise_id:'unknown',sets:3,reps:3}]}],names),/不在已加载/);
  assert.throws(()=>applyActions(fixture(),[{type:'create_routine',name:'推日',exercises:[{exercise_id:'0025',sets:0,reps:3}]}],names),/sets/);
  assert.throws(()=>applyActions(fixture(),[{type:'create_routine',name:'推日',exercises:[{exercise_id:'0025',sets:3,reps:3}],weekdays:[1,1]}],names),/不重复/);
});

test('Bridge preview retains generated routine ID and write verifies created routine',async()=>{
  const client=new FakeClient();
  const names={'0025':'杠铃卧推'};
  const bridge=new PersonalGymBridge({backup:{create:async()=>({id:'synthetic-backup'})},client,writes:true,loadNames:async()=>names});
  const proposal=await bridge.preview({actions:[{type:'create_routine',name:'新推日',exercises:[{exercise_id:'0025',sets:3,reps:3}],weekdays:[1]}]});
  const createdChange=proposal.changes.find(x=>x.type==='create_routine');
  assert.ok(createdChange.routine_id);
  const result=await bridge.apply({proposal_id:proposal.proposal_id,confirmation:'我确认写入'});
  assert.equal(result.verified,true);
  assert.equal(client.data.routines.at(-1).id,createdChange.routine_id);
  assert.equal(client.data.week[1],createdChange.routine_id);
});

test('Reject unknown routines, invalid days, unknown action props',()=>{
  assert.throws(()=>applyActions(fixture(),[{type:'assign_weekday',weekday:7,routine_id:'r-A'}]));
  assert.throws(()=>applyActions(fixture(),[{type:'override_date',date:'2000-02-31',routine_id:'r-A'}]));
  assert.throws(()=>applyActions(fixture(),[{type:'assign_weekday',weekday:3,routine_id:'missing'}]));
  assert.throws(()=>applyActions(fixture(),[{type:'set_exercise_target',routine_id:'r-A',exercise_index:1,weight:-1}]));
  assert.throws(()=>applyActions(fixture(),[{type:'set_exercise_target',routine_id:'r-A',exercise_index:1,weight:4,evil:true}]));
});

test('Preview is read-only, write is gated',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({backup:{create:async()=>({id:'synthetic-backup'})},client,writes:false});
  const proposal=await bridge.preview({actions:[{type:'override_date',date:'2000-01-06',routine_id:'r-A'}]});
  assert.equal(proposal.changes.length,1);
  assert.equal(client.rev,4);
  await assert.rejects(()=>bridge.apply({proposal_id:proposal.proposal_id,confirmation:'我确认写入'}),/未启用/);
  assert.equal(client.beforePut,null);
});

test('Approved write uses baseRev and baseWid, re-reads verification',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({backup:{create:async()=>({id:'synthetic-backup'})},client,writes:true});
  const proposal=await bridge.preview({actions:[{type:'set_exercise_target',routine_id:'r-A',exercise_index:0,sets:2}]});
  await assert.rejects(()=>bridge.apply({proposal_id:proposal.proposal_id,confirmation:'approve'}),/确认/);
  const result=await bridge.apply({proposal_id:proposal.proposal_id,confirmation:'我确认写入'});
  assert.equal(result.verified,true);
  assert.equal(client.data.routines[0].ex[0].sets,2);
  assert.equal(client.beforePut.baseRev,4);
  assert.equal(client.beforePut.baseWid,'0123456789abcdef');
  assert.equal(client.beforePut.state.keepMe,'untouched');
  await assert.rejects(()=>bridge.apply({proposal_id:proposal.proposal_id,confirmation:'我确认写入'}),/预览不存在/);
});

test('Reject outdated snapshot without touching server',async()=>{
  const client=new FakeClient();
  const bridge=new PersonalGymBridge({backup:{create:async()=>({id:'synthetic-backup'})},client,writes:true});
  const proposal=await bridge.preview({actions:[{type:'assign_weekday',weekday:5,routine_id:'r-A'}]});
  client.rev=5;client.data._wid='new-write-id';
  await assert.rejects(()=>bridge.apply({proposal_id:proposal.proposal_id,confirmation:'我确认写入'}),/拒绝覆盖/);
  assert.equal(client.beforePut,null);
});

test('MCP initialize and tool calls return valid JSON-RPC',async()=>{
  const bridge=new PersonalGymBridge({backup:{create:async()=>({id:'synthetic-backup'})},client:new FakeClient(),writes:false});
  const hello=await dispatch({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18'}},bridge);
  assert.equal(hello.result.protocolVersion,'2025-06-18');
  const tools=await dispatch({jsonrpc:'2.0',id:1,method:'tools/list'},bridge);
  assert.equal(tools.result.tools.some(x=>x.name==='apply_plan_change'),false);
  const call=await dispatch({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_plan',arguments:{}}},bridge);
  assert.equal(call.result.isError,false);
  assert.equal(call.result.structuredContent.routines[0].name,'Synthetic routine A');
  const noti=await dispatch({jsonrpc:'2.0',method:'notifications/initialized'},bridge);
  assert.equal(noti,null);
});

test('HTTP transport requires bearer token and speaks JSON-RPC',async()=>{
  const bridge=new PersonalGymBridge({backup:{create:async()=>({id:'synthetic-backup'})},client:new FakeClient(),writes:false});
  const server=createHttpServer(bridge,'a'.repeat(64));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const unauth=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(unauth.status,401);
    const success=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'a'.repeat(64),Accept:'application/json,text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})});
    assert.equal(success.status,200);
    assert.equal((await success.json()).result.tools.length,15);
    const customHeader=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'a'.repeat(64),Accept:'application/json,text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/list'})});
    assert.equal(customHeader.status,200);
    assert.equal((await customHeader.json()).result.tools.length,15);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
