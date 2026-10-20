import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup,FakeClient,approve,fixture,catalogue } from './fixtures.mjs';
import { PersonalGymBridge } from '../src/plan.mjs';
import { dispatch,listTools,createHttpServer } from '../src/mcp.mjs';
import { DraftStore } from '../src/draft-store.mjs';
import { analyse } from '../src/v040.mjs';
async function harness(t,options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'opengym-v040-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const client=options.client||new FakeClient();client.baseUrl='https://synthetic.invalid';client.account='fictional-A';client.refreshLogin=async()=>({user:{id:client.account,name:'Synthetic'}});
 const x=setup({...options,client,localDirectory:directory});
 const call=async(name,args={})=>{const r=await dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},x.bridge);
  if(r.error)throw Object.assign(new Error(r.error.message),{code:r.error.code});if(r.result.isError){const e=JSON.parse(r.result.content[0].text);throw Object.assign(new Error(e.error),{code:e.code});}return r.result.structuredContent;};
 return {...x,call,directory};
}
async function ready(x){let d=await x.call('start_workout_draft',{date:'2000-02-01',name:'Synthetic draft'});d=await x.call('draft_add_exercise',{draft_id:d.draft_id,expected_revision:d.revision,exercise_id:'b'});return x.call('draft_add_set',{draft_id:d.draft_id,expected_revision:d.revision,exercise_index:0,set:{weight:2,reps:3}});}
const preview=(x,d)=>x.call('preview_finish_workout_draft',{draft_id:d.draft_id});
const get=(x,d)=>x.call('get_workout_draft',{draft_id:d.draft_id});
const edit=(x,d,name,extra={})=>x.call(name,{draft_id:d.draft_id,expected_revision:d.revision,...extra});

test('Routine edit batch uses unchanged safe preview/backup/CAS/single PUT/reread flow',async t=>{
 const x=await harness(t),original=structuredClone(x.client.data);const p=await x.call('preview_plan_change',{actions:[
 {type:'rename_routine',routine_id:'r',name:'Synthetic renamed'},
 {type:'add_routine_exercise',routine_id:'r',exercise:{exercise_id:'b',sets:2,reps:6}},
 {type:'move_routine_exercise',routine_id:'r',exercise_index:1,to_index:0},
 {type:'replace_routine_exercise',routine_id:'r',exercise_index:1,exercise:{exercise_id:'t',sets:1,reps:5}},
 {type:'set_exercise_target',routine_id:'r',exercise_index:0,reps:8},
 {type:'remove_routine_exercise',routine_id:'r',exercise_index:1}]});
 assert.equal(p.changes.length,6);assert.deepEqual(x.client.data,original);await assert.rejects(()=>x.call('apply_plan_change',{proposal_id:p.proposal_id}));
 const r=await x.call('apply_plan_change',approve(p));assert.equal(r.verified,true);assert.equal(x.client.puts.length,1);assert.equal(x.backups.length,1);assert.deepEqual(x.backups[0].snapshot.state,original);assert.deepEqual(x.client.data.opaque,original.opaque);assert.equal(x.client.data.routines[0].id,'r');assert.equal(x.client.data.routines[0].ex[0].reps,8);
});
for(const [label,action] of [
 ['unknown',{type:'add_routine_exercise',routine_id:'r',exercise:{exercise_id:'unknown',sets:1,reps:1}}],
 ['duplicate',{type:'add_routine_exercise',routine_id:'r',exercise:{exercise_id:'a',sets:1,reps:1}}],
 ['last deletion',{type:'remove_routine_exercise',routine_id:'r',exercise_index:0}],
 ['index',{type:'move_routine_exercise',routine_id:'r',exercise_index:10,to_index:0}],
 ['unknown argument',{type:'rename_routine',routine_id:'r',name:'Synthetic',private_key:'not stored'}],
])test('Routine rejects '+label+' before write',async t=>{const x=await harness(t);await assert.rejects(()=>x.call('preview_plan_change',{actions:[action]}));assert.equal(x.client.puts.length,0);});
test('Replacement preserves same-ID unknown fields and rejects dropping different-ID extensions',async t=>{
 const x=await harness(t);x.client.data.routines[0].ex[0].opaque=42;
 await assert.rejects(()=>x.bridge.preview({actions:[{type:'replace_routine_exercise',routine_id:'r',exercise_index:0,exercise:{exercise_id:'b',sets:1,reps:4}}]}));
 const p=await x.bridge.preview({actions:[{type:'replace_routine_exercise',routine_id:'r',exercise_index:0,exercise:{exercise_id:'a',sets:1,reps:4}}]});await x.bridge.apply(approve(p));assert.equal(x.client.data.routines[0].ex[0].opaque,42);
});
test('Draft MCP preview binds exact revision and kind; only approved commit writes once',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d);assert.equal(p.total_sets,1);assert.equal(x.client.puts.length,0);
 await assert.rejects(()=>x.call('log_workout',approve(p)),e=>e.code==='expired');await assert.rejects(()=>x.call('commit_finished_workout_draft',{proposal_id:p.proposal_id}));
 const r=await x.call('commit_finished_workout_draft',approve(p));assert.equal(r.verified,true);assert.equal(x.client.puts.length,1);assert.equal(x.backups.length,1);assert.equal((await get(x,d)).status,'committed');
 await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)));assert.equal(x.client.puts.length,1);
});
test('Post-preview draft correction blocks old proposal before submission',async t=>{
 const x=await harness(t);let d=await ready(x);const p=await preview(x,d);d=await edit(x,d,'draft_update_set',{exercise_index:0,set_index:0,set:{weight:3,reps:6}});
 await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)),e=>e.code==='conflict');assert.equal(x.client.puts.length,0);assert.equal((await preview(x,d)).draft_revision,d.revision);
});
test('Pending journal is durable before network and blocks cancellation/second preview in flight',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d);let started,release;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r),put=x.client.putData.bind(x.client);
 x.client.putData=async data=>{started();await gate;return put(data);};const pending=x.call('commit_finished_workout_draft',approve(p));await began;
 const current=await get(x,d);assert.equal(current.status,'verification_pending');await assert.rejects(()=>preview(x,d));await assert.rejects(()=>edit(x,current,'abandon_workout_draft'));release();assert.equal((await pending).verified,true);
});
test('Timeout after server commit recovers across restart by exact read-only verification',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d),put=x.client.putData.bind(x.client);x.client.putData=async data=>{await put(data);throw new Error('synthetic timeout');};
 assert.equal((await x.call('commit_finished_workout_draft',approve(p))).status,'verification_pending');
 const restarted=new PersonalGymBridge({client:x.client,writes:true,localDirectory:x.directory,loadCatalogue:async()=>catalogue});
 const r=await restarted.features.call('recover_workout_draft',{draft_id:d.draft_id});assert.equal(r.recovered,true);assert.equal(r.draft.status,'committed');assert.equal(x.client.puts.length,1);
 await assert.rejects(()=>restarted.features.call('preview_finish_workout_draft',{draft_id:d.draft_id}));
});
test('Timeout without acceptance or changed content stays locked, never blind resubmit',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d);let attempts=0;x.client.putData=async()=>{attempts++;throw new Error('synthetic timeout');};await x.call('commit_finished_workout_draft',approve(p));
 assert.equal((await x.call('recover_workout_draft',{draft_id:d.draft_id})).recovered,false);const current=await get(x,d);x.client.data.workouts.push({...current.submission.workout,name:'different'});x.client.rev++;
 assert.equal((await x.call('recover_workout_draft',{draft_id:d.draft_id})).recovered,false);await assert.rejects(()=>preview(x,d));await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)));assert.equal(attempts,1);
});
for(const status of [403,409])test('Definite HTTP '+status+' has no automatic retry or draft unlock',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d);let attempts=0;x.client.putData=async()=>{attempts++;throw Object.assign(new Error('Synthetic refusal'),{status});};
 await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)));await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)));assert.equal(attempts,1);assert.equal((await get(x,d)).status,'verification_pending');
});
test('Stale upstream, expired proposal and failed backup never cross durable barrier',async t=>{
 let now=100;const x=await harness(t,{now:()=>now,ttl:1000}),d=await ready(x);let p=await preview(x,d);now=1101;await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)));
 now=2000;p=await preview(x,d);x.client.rev++;await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)),e=>e.code==='conflict');p=await preview(x,d);x.bridge.writer.backup={create:async()=>{throw new Error('Synthetic failure');}};
 await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)),e=>e.code==='backup-failed');assert.equal(x.client.puts.length,0);assert.equal((await get(x,d)).status,'open');
});
test('Paired account switch isolates drafts, feedback and preview commits',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d);await x.call('record_body_feedback',{date:'2000-02-01',body_weight:70,unit:'kg'});x.client.account='fictional-B';
 assert.equal((await x.call('list_workout_drafts')).total,0);assert.equal((await x.call('list_body_feedback')).total,0);await assert.rejects(()=>get(x,d));await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)),e=>e.code==='account-mismatch');assert.equal(x.client.puts.length,0);
});
test('Missing stable identity fails closed for private records',async t=>{const x=await harness(t);x.client.refreshLogin=async()=>({user:{name:'Synthetic'}});await assert.rejects(()=>x.call('start_workout_draft',{date:'2000-02-01',name:'Synthetic'}));});
test('Draft persists across restart; corrections/removals/notes/cancellation only affect private store',async t=>{
 const x=await harness(t);let d=await ready(x);const restarted=new PersonalGymBridge({client:x.client,writes:true,localDirectory:x.directory});assert.equal((await restarted.features.call('get_workout_draft',{draft_id:d.draft_id})).revision,d.revision);
 d=await edit(x,d,'draft_update_set',{exercise_index:0,set_index:0,set:{weight:3,reps:6}});d=await edit(x,d,'draft_set_note',{note:'Synthetic note'});d=await edit(x,d,'draft_remove_set',{exercise_index:0,set_index:0});d=await edit(x,d,'draft_remove_exercise',{exercise_index:0});d=await edit(x,d,'abandon_workout_draft');assert.equal(d.status,'abandoned');assert.equal(x.client.puts.length,0);await assert.rejects(()=>preview(x,d));
});
test('Set validators refuse mixed formats, unknown IDs and unapproved schema extensions',async t=>{
 const x=await harness(t),d=await ready(x);await assert.rejects(()=>edit(x,d,'draft_add_exercise',{exercise_id:'unknown'}));
 for(const set of [{reps:1,seconds:1},{reps:1,unexpected:true},{sides:{L:{reps:2},R:{reps:2}},done:true},{seconds:1,side:'invalid'}])await assert.rejects(()=>edit(x,d,'draft_add_set',{exercise_index:0,set}));
 assert.equal((await get(x,d)).revision,d.revision);
});
test('Unilateral draft data uses actual sides, warmups and explicit per-dumbbell semantics',async t=>{
 const x=await harness(t);let d=await x.call('start_workout_draft',{date:'2000-02-01',name:'Synthetic sides'});d=await edit(x,d,'draft_add_exercise',{exercise_id:'b',weight_basis:'per_dumbbell'});
 d=await edit(x,d,'draft_add_set',{exercise_index:0,set:{phase:'work',sides:{L:{weight:3,reps:4,done:true},R:{weight:2,reps:3,done:false}}}});
 await assert.rejects(()=>edit(x,d,'draft_add_set',{exercise_index:0,set:{weight:3,reps:4}}));const p=await preview(x,d);assert.equal(p.total_sets,1);assert.equal(p.records[0].exercises[0].sets[0].sides.L.reps,4);
});
test('Bodyweight/feedback are explicit private records, survive restart and never modify upstream schema',async t=>{
 const x=await harness(t),before=structuredClone(x.client.data);await assert.rejects(()=>x.call('record_body_feedback',{date:'2000-02-01',body_weight:70}));await assert.rejects(()=>x.call('record_body_feedback',{date:'2000-02-30',feedback:'Synthetic'}));
 const r=await x.call('record_body_feedback',{date:'2000-02-01',body_weight:70,unit:'kg',feedback:'x'.repeat(500)});assert.equal(r.synced_to_opengym,false);
 const restarted=new PersonalGymBridge({client:x.client,writes:true,localDirectory:x.directory});const all=await restarted.features.call('list_body_feedback',{});assert.equal(all.records[0].feedback.length,500);assert.deepEqual(x.client.data,before);assert.equal(x.client.puts.length,0);
});
test('Store CAS, cross-instance locks, permissions, path traversal, symlinks and corrupt JSON',async t=>{
 const x=await harness(t),store=new DraftStore(path.join(x.directory,'synthetic-store')),d=await store.create({exercises:[]}),other=new DraftStore(store.directory);
 const both=await Promise.allSettled([store.edit(d.draft_id,1,v=>v.note='a'),other.edit(d.draft_id,1,v=>v.note='b')]);assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal((await other.get(d.draft_id)).revision,2);
 assert.equal((await fs.stat(store.file(d.draft_id))).mode&0o777,0o600);assert.equal((await fs.stat(store.directory)).mode&0o777,0o700);await assert.rejects(()=>store.get('../../etc/passwd'));
 await fs.mkdir(path.join(store.directory,`.${d.draft_id}.lock`));await assert.rejects(()=>other.edit(d.draft_id,2,()=>{}),e=>e.code==='busy');
 const link=path.join(x.directory,'link');await fs.symlink(store.directory,link);await assert.rejects(()=>new DraftStore(link).list());
 await fs.unlink(store.file(d.draft_id));await fs.symlink(path.join(x.directory,'missing'),store.file(d.draft_id));await assert.rejects(()=>store.get(d.draft_id));await fs.unlink(store.file(d.draft_id));await fs.writeFile(store.file(d.draft_id),'{bad');await assert.rejects(()=>store.get(d.draft_id));
});
test('Read-only mode hides local writers and HTTP auth protects private reads',async t=>{
 const x=await harness(t,{writes:false});for(const name of ['start_workout_draft','commit_finished_workout_draft','record_body_feedback'])assert.ok(!listTools(false).some(t=>t.name===name));
 await assert.rejects(()=>x.call('start_workout_draft',{date:'2000-02-01',name:'Synthetic'}));await assert.rejects(()=>x.bridge.features.call('record_body_feedback',{date:'2000-02-01',feedback:'Synthetic'}));
 const server=createHttpServer(x.bridge,'synthetic-access-token');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const reply=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_workout_drafts'}})});assert.equal(reply.status,401);
});
const summary=s=>analyse(s,{from:'1999-12-27',to:'2000-01-16'},catalogue,true);
test('Weekly trends use Monday calendar boundaries and include zero-activity weeks',()=>{
 const s=fixture();s.workouts.push({id:'w2',d:'2000-01-03',entries:[{id:'b',sets:[{w:3,r:4,done:true},{w:20,r:20,done:true,phase:'warmup'}]}]});const r=summary(s);assert.equal(r.weeks.length,3);assert.equal(r.weeks[0].volume_by_weight_basis.as_recorded,25);assert.equal(r.weeks[1].volume_by_weight_basis.as_recorded,12);assert.equal(r.weeks[1].completed_work_sets,1);assert.equal(r.weeks[2].workouts,0);assert.equal(r.weeks[2].change_from_previous_week.workouts,-1);
});
test('Progress preserves repeated occurrences and splits weight bases without conversion',()=>{
 const s=fixture();s.workouts[0].entries.push({id:'a',target:{dbLoad:'each'},sets:[{w:2,r:3,done:true}]});const r=analyse(s,{exercise_id:'a',limit:1},catalogue);assert.equal(r.total,2);assert.equal(r.next_offset,1);assert.equal(r.totals_by_weight_basis.per_dumbbell.volume,12);assert.equal(r.totals_by_weight_basis.as_recorded.volume,25);
});
test('Muscle credits distinguish primary/secondary, snapshot mapping and missing metadata',()=>{
 const s=fixture();s.customEx=[{id:'c',primaries:['chest','chest'],secondaries:['chest','triceps']}];s.workouts[0].entries.push({id:'c',sets:[{w:2,r:3,done:true}]},{id:'unknown',sets:[{w:2,r:3,done:true}]});const r=summary(s).weeks[0];assert.equal(r.muscles.chest.primary_sets,2);assert.equal(r.muscles.triceps.secondary_sets,1);assert.equal(r.unmapped_sets,1);
 s.workouts[0].entries[0].muscleSnapshot.primaries=['abs'];assert.equal(summary(s).weeks[0].muscles.abs.primary_sets,1);
});
test('Timed/unchecked/warmup and unilateral rows follow recorded volume semantics',()=>{
 const s=fixture();s.workouts[0].entries=[{id:'t',sets:[{mode:'time',sec:30,w:2,done:true},{w:20,r:20,done:true,phase:'warmup'},{w:100,r:100,done:false}]},{id:'b',sets:[{sides:{L:{w:3,r:4,done:true},R:{w:2,r:3,done:false}}}]}];const r=summary(s).weeks[0];assert.equal(r.completed_work_sets,2);assert.equal(r.volume_by_weight_basis.as_recorded,12);
});
test('Assisted progress reports lower positive assistance as better and rejects impossible ranges',()=>{
 const s=fixture();s.workouts[0].entries=[{id:'assist',sets:[{w:40,r:4,done:true},{w:30,r:4,done:true}]}];const r=analyse(s,{exercise_id:'assist'},catalogue);assert.equal(r.records[0].best_load,30);assert.equal(r.records[0].assisted,true);
 for(const q of [{from:'2000-02-30',to:'2000-03-01'},{from:'2001-01-01',to:'2000-01-01'},{from:'2000-01-01',to:'2002-01-01'}])assert.throws(()=>analyse(s,q,catalogue,true));
});
test('Read-only analysis MCP routes preserve original data',async t=>{
 const x=await harness(t,{writes:false}),before=structuredClone(x.client.data);for(const [name,args] of [['get_workout_progress',{exercise_id:'a'}],['get_weekly_training_summary',{from:'1999-12-27',to:'2000-01-16'}]])assert.ok(await x.call(name,args));assert.deepEqual(x.client.data,before);assert.equal(x.client.puts.length,0);
});
test('Failed durable pre-submit journal prevents PUT, while failed local settlement remains recoverable',async t=>{
 const x=await harness(t),d=await ready(x);let p=await preview(x,d);const write=DraftStore.prototype.write;
 try{
  DraftStore.prototype.write=async function(value){if(value.status==='verification_pending')throw new Error('synthetic storage failure');return write.call(this,value);};
  await assert.rejects(()=>x.call('commit_finished_workout_draft',approve(p)));assert.equal(x.client.puts.length,0);assert.equal((await get(x,d)).status,'open');
  DraftStore.prototype.write=write;p=await preview(x,d);
  DraftStore.prototype.write=async function(value){if(value.status==='committed')throw new Error('synthetic settlement failure');return write.call(this,value);};
  const r=await x.call('commit_finished_workout_draft',approve(p));assert.equal(r.verified,true);assert.equal(r.draft_status,'verification_pending');assert.equal(x.client.puts.length,1);
 }finally{DraftStore.prototype.write=write;}
 assert.equal((await x.call('recover_workout_draft',{draft_id:d.draft_id})).recovered,true);assert.equal(x.client.puts.length,1);
});
test('Accepted write with failed reread remains pending and recovers without a second PUT',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d);const read=x.client.getData.bind(x.client);let fail=false;const put=x.client.putData.bind(x.client);
 x.client.putData=async payload=>{const result=await put(payload);fail=true;return result;};x.client.getData=async()=>{if(fail)throw new Error('synthetic read failure');return read();};
 const result=await x.call('commit_finished_workout_draft',approve(p));assert.equal(result.verified,false);fail=false;assert.equal((await x.call('recover_workout_draft',{draft_id:d.draft_id})).recovered,true);assert.equal(x.client.puts.length,1);
});
test('Deleted/multiple same-ID records cannot satisfy pending recovery',async t=>{
 const x=await harness(t),d=await ready(x),p=await preview(x,d),put=x.client.putData.bind(x.client);x.client.putData=async payload=>{await put(payload);throw new Error('synthetic timeout');};await x.call('commit_finished_workout_draft',approve(p));
 const current=await get(x,d),actual=x.client.data.workouts.find(w=>w.id===current.submission.workout.id);actual.deleted=true;assert.equal((await x.call('recover_workout_draft',{draft_id:d.draft_id})).recovered,false);delete actual.deleted;x.client.data.workouts.push(structuredClone(actual));assert.equal((await x.call('recover_workout_draft',{draft_id:d.draft_id})).recovered,false);
});
test('Oversized document and atomic rename failure publish no partial replacement',async t=>{
 const x=await harness(t),store=new DraftStore(path.join(x.directory,'atomic')),d=await store.create({exercises:[]}),before=await fs.readFile(store.file(d.draft_id),'utf8');
 await assert.rejects(()=>store.edit(d.draft_id,1,v=>v.note='x'.repeat(270000)));assert.equal(await fs.readFile(store.file(d.draft_id),'utf8'),before);
 const rename=fs.rename;try{fs.rename=async()=>{throw new Error('synthetic rename failure');};await assert.rejects(()=>store.edit(d.draft_id,1,v=>v.note='new'));}finally{fs.rename=rename;}
 assert.equal(await fs.readFile(store.file(d.draft_id),'utf8'),before);assert.deepEqual(await fs.readdir(store.directory),[d.draft_id+'.json']);
});
test('Ancestor symlink is refused before creating a directory in its target',async t=>{
 const x=await harness(t),target=path.join(x.directory,'target');await fs.mkdir(target);await fs.symlink(target,path.join(x.directory,'alias'));await assert.rejects(()=>new DraftStore(path.join(x.directory,'alias','child')).list());assert.deepEqual(await fs.readdir(target),[]);
});
test('Feedback/draft pagination, inclusive dates and invalid ranges are explicit',async t=>{
 const x=await harness(t);for(const date of ['2000-02-01','2000-02-02','2000-02-03'])await x.call('record_body_feedback',{date,feedback:'Synthetic'});
 const p=await x.call('list_body_feedback',{from:'2000-02-01',to:'2000-02-03',limit:1});assert.equal(p.total,3);assert.equal(p.next_offset,1);assert.equal((await x.call('list_body_feedback',{from:'2000-02-02',to:'2000-02-02'})).total,1);await assert.rejects(()=>x.call('list_body_feedback',{from:'2000-03-01',to:'2000-02-01'}));
 await ready(x);await ready(x);assert.equal((await x.call('list_workout_drafts',{limit:1})).next_offset,1);
});
