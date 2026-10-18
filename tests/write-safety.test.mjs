import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approve, customCreate, logInput, FakeClient } from './fixtures.mjs';
import { GuardedWrites } from '../src/write-safety.mjs';
const paths=[
  ['plan',b=>b.preview({actions:[{type:'assign_weekday',weekday:2,routine_id:'r'}]}),(b,p)=>b.apply(p)],
  ['workout_log',b=>b.previewWorkoutLog(logInput),(b,p)=>b.logWorkout(p)],
  ['custom_exercise',b=>b.previewCustomExerciseChange({actions:[customCreate]}),(b,p)=>b.applyCustomExerciseChange(p)],
  ['workout_edit',b=>b.previewWorkoutEdit({workout_id:'w1',actions:[{type:'set_note',note:'新的虚构备注'}]}),(b,p)=>b.applyWorkoutEdit(p)],
];
for(const [kind,preview,commit] of paths){
  test(`${kind}: backup captures exact fresh preimage, then one versioned PUT and verified reread`,async()=>{
    const {bridge,client,backups}=setup();const before=structuredClone(client.data);const p=await preview(bridge);
    assert.equal(client.puts.length,0);assert.equal(backups.length,0);
    const result=await commit(bridge,approve(p));
    assert.equal(result.status,'verified');assert.equal(result.applied,true);assert.equal(result.verified,true);
    assert.equal(backups.length,1);assert.equal(backups[0].operation,kind);assert.deepEqual(backups[0].snapshot.state,before);
    assert.equal(client.puts.length,1);assert.equal(client.puts[0].baseRev,4);assert.equal(client.puts[0].baseWid,'synthetic-write-4');
    assert.equal(client.puts[0].stamped,undefined);assert.ok(client.reads>=3);
    await assert.rejects(()=>commit(bridge,approve(p)),e=>e.code==='expired');assert.equal(client.puts.length,1);
  });
  test(`${kind}: failed backup prevents submission and hides underlying sensitive error`,async()=>{
    const {bridge,client}=setup({backup:{create:async()=>{throw new Error('synthetic-sensitive-message');}}});
    const p=await preview(bridge);await assert.rejects(()=>commit(bridge,approve(p)),e=>e.code==='backup-failed'&&!e.message.includes('synthetic-sensitive'));
    assert.equal(client.puts.length,0);
  });
  test(`${kind}: disabled writes and missing human approval cannot submit`,async()=>{
    const {bridge,client}=setup({writes:false});const p=await preview(bridge);
    await assert.rejects(()=>commit(bridge,approve(p)),e=>e.code==='write-disabled');
    const enabled=setup();const q=await preview(enabled.bridge);
    await assert.rejects(()=>commit(enabled.bridge,{proposal_id:q.proposal_id,confirmation:'approve'}),e=>e.code==='approval-required');
    assert.equal(client.puts.length+enabled.client.puts.length,0);
  });
}
test('Expiry, write-ID changes and silent state changes each block stale proposals',async()=>{
  for(const mutation of ['expire','wid','content']){
    let now=0;const {bridge,client,backups}=setup({now:()=>now});
    const p=await paths[0][1](bridge);
    if(mutation==='expire')now=600000;
    if(mutation==='wid')client.data._wid='synthetic-other-device';
    if(mutation==='content')client.data.opaque.preserve=false;
    await assert.rejects(()=>bridge.apply(approve(p)),e=>['expired','conflict'].includes(e.code));
    assert.equal(client.puts.length,0);assert.equal(backups.length,0);
  }
});
test('A 409 is reported as conflict and is never retried',async()=>{
  const {bridge,client}=setup();let attempts=0;
  client.putData=async()=>{attempts++;throw Object.assign(new Error('synthetic conflict'),{status:409});};
  const p=await paths[0][1](bridge);await assert.rejects(()=>bridge.apply(approve(p)),e=>e.code==='conflict');
  await assert.rejects(()=>bridge.apply(approve(p)),e=>e.code==='expired');assert.equal(attempts,1);
});
test('A timeout after the server commits returns pending and consumes the proposal',async()=>{
  const {bridge,client}=setup();const put=client.putData.bind(client);
  client.putData=async p=>{await put(p);throw new Error('synthetic response lost');};
  const p=await bridge.previewWorkoutLog(logInput);const result=await bridge.logWorkout(approve(p));
  assert.equal(result.status,'verification_pending');assert.equal(result.applied,null);assert.equal(result.verified,false);
  assert.equal(client.data.workouts.length,2);assert.equal(client.puts.length,1);
  await assert.rejects(()=>bridge.logWorkout(approve(p)),e=>e.code==='expired');assert.equal(client.puts.length,1);
});
test('Accepted write followed by failed or mismatching reread is pending, not a retry',async()=>{
  for(const fail of [true,false]){
    const {bridge,client}=setup();const p=await paths[0][1](bridge);const read=client.getData.bind(client);
    client.getData=async()=>{if(client.puts.length){if(fail)throw new Error('synthetic offline');client.data.week={};}return read();};
    const result=await bridge.apply(approve(p));assert.equal(result.applied,true);assert.equal(result.verified,false);assert.equal(result.status,'verification_pending');assert.equal(client.puts.length,1);
  }
});
test('Definite server refusal has write-failed classification; missing backup is refused',async()=>{
  const {bridge,client}=setup();client.putData=async()=>{throw Object.assign(new Error('synthetic rejected'),{status:422});};
  const p=await paths[0][1](bridge);await assert.rejects(()=>bridge.apply(approve(p)),e=>e.code==='write-failed');
  bridge.writer.backup=undefined;const q=await paths[0][1](bridge);await assert.rejects(()=>bridge.apply(approve(q)),e=>e.code==='backup-failed');
});
test('Proposal kinds cannot be interchanged and no-op has no proposal',async()=>{
  const {bridge,client}=setup();const p=await paths[0][1](bridge);
  await assert.rejects(()=>bridge.applyWorkoutEdit(approve(p)),e=>e.code==='expired');
  const q=await bridge.previewWorkoutEdit({workout_id:'w1',actions:[{type:'set_note',note:'虚构备注'}]});
  assert.equal(q.changed,false);assert.equal(q.proposal_id,null);assert.equal(client.puts.length,0);
});
test('Expiry during backup blocks the PUT and concurrent commits are refused',async()=>{
  let now=0,release;const wait=new Promise(resolve=>{release=resolve;});
  const {bridge,client}=setup({now:()=>now,backup:{create:async()=>{await wait;now=600001;return {id:'synthetic'};}}});
  const p=await paths[0][1](bridge);const first=bridge.apply(approve(p));
  await assert.rejects(()=>bridge.apply(approve(p)),e=>e.code==='busy');release();
  await assert.rejects(()=>first,e=>e.code==='expired');assert.equal(client.puts.length,0);
});
test('Verification tolerates only server metadata and device-local active session',async()=>{
  const client=new FakeClient();const writer=new GuardedWrites({client,writes:true,backup:{create:async()=>({id:'synthetic'})}});
  const snap=await client.getData();const next=structuredClone(snap.state);next.opaque.added=true;next.active={synthetic:true};
  const p=writer.prepare('plan',snap,next,{});const put=client.putData.bind(client);client.putData=async x=>{const out=await put(x);delete client.data.active;return out;};
  assert.equal((await writer.commit('plan',approve(p))).verified,true);
});
