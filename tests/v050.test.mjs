import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatch } from '../src/mcp.mjs';
import { CatalogueRefresh } from '../src/catalogue-refresh.mjs';
import { buildCatalogue, extractCatalogueArray } from '../src/catalogue.mjs';
import { weightsForEntry } from '../src/muscle-weights.mjs';
import { setup, approve } from './fixtures.mjs';

async function harness(t) {
  const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'v050-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let now=Date.parse('2000-01-02T16:05:00Z');
  const fixture=setup({localDirectory:directory,now:()=>now});
  const {client,bridge}=fixture;
  client.baseUrl='https://synthetic.invalid';
  client.refreshLogin=async()=>({user:{id:'synthetic-v050'}});
  const call=async(name,args={})=>{
    const response=await dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},bridge);
    if(response.error)throw Error(response.error.message);
    if(response.result.isError){
      const error=JSON.parse(response.result.content[0].text);
      throw Object.assign(new Error(error.error),{code:error.code});
    }
    return response.result.structuredContent;
  };
  return {...fixture,call,directory,advance:seconds=>now+=seconds*1000};
}

test('Today resolves across midnight in selected zone, rest, override, queue, pin, and valid combined weekday',async t=>{
  const h=await harness(t),s=h.client.data;
  s.routines.push({id:'timed',name:'Synthetic timer',ex:[{id:'t',sets:2,mode:'time',sec:25,prog:'off'}]});
  s.week={0:'timed',1:['r','timed']};
  const get=time_zone=>h.call('get_today_plan',{time_zone});
  assert.equal((await get('UTC')).date,'2000-01-02');
  assert.deepEqual((await get('Asia/Shanghai')).routine_ids,['r','timed']);
  s.dayPlan={'2000-01-03':'rest'};
  assert.equal((await get('Asia/Shanghai')).source,'rest_override');
  assert.equal((await h.call('start_planned_workout',{time_zone:'Asia/Shanghai'})).rest_day,true);
  s.dayPlan['2000-01-03']='missing';
  assert.equal((await get('Asia/Shanghai')).needs_choice,true);
  s.dayPlan['2000-01-03']='timed';
  assert.equal((await get('Asia/Shanghai')).source,'override');
  s.queue={ids:['timed'],startsOn:'2000-01-03'};assert.equal((await get('Asia/Shanghai')).source,'pinned');
  delete s.dayPlan['2000-01-03'];assert.deepEqual((await get('Asia/Shanghai')).routine_ids,['timed','r']);
  await assert.rejects(()=>get('not-a-zone'));
  assert.equal(h.client.puts.length,0);assert.equal(h.backups.length,0);
});

test('Planned timed and unilateral draft survives service reconstruction and reports measured work before one PUT',async t=>{
  const h=await harness(t),s=h.client.data;
  s.routines[0].ex=[{id:'a',sets:2,reps:6,weight:4,side:true,prog:'off',restSec:100,sideRestSec:20},
    {id:'t',sets:1,mode:'time',sec:25,prog:'off',warmupRestSec:30}];
  s.week={1:'r'};
  const args={time_zone:'Asia/Shanghai'};
  let draft=await h.call('start_planned_workout',args);
  assert.equal(draft.exercises[0].sets.length,0);
  assert.equal(draft.opening_targets[0].opening.side_rest_seconds,20);
  assert.equal(draft.opening_targets[1].opening.sec,25);
  assert.equal(draft.opening_targets[1].opening.warmup_rest_seconds,30);
  const edit=(name,input)=>h.call(name,{draft_id:draft.draft_id,expected_revision:draft.revision,...input});
  h.advance(10);draft=await edit('draft_session_clock',{action:'pause'});
  h.advance(120);
  const {bridge}=setup({client:h.client,localDirectory:h.directory});
  const reopened=await bridge.features.call('get_workout_draft',{draft_id:draft.draft_id});
  assert.deepEqual(reopened,draft);draft=await edit('draft_session_clock',{action:'resume'});
  draft=await edit('draft_add_set',{exercise_index:0,set:{sides:{L:{weight:4,reps:3},R:{weight:4,reps:3,done:false}}}});
  draft=await edit('draft_add_set',{exercise_index:1,set:{seconds:23}});
  await assert.rejects(()=>h.call('preview_finish_workout_draft',{draft_id:draft.draft_id}));
  h.advance(50);draft=await edit('draft_session_clock',{action:'end'});
  s.routines[0].ex[1].sec=99;
  const preview=await h.call('preview_finish_workout_draft',{draft_id:draft.draft_id});
  assert.equal(preview.completion.completion_rate,2/3);assert.equal(preview.completion.active_seconds,60);
  assert.equal(preview.completion.total_seconds,180);
  assert.equal(preview.records[0].exercises[1].sets[0].seconds,23);
  assert.equal(h.client.puts.length,0);
  const result=await h.call('commit_finished_workout_draft',approve(preview));
  assert.equal(result.verified,true);assert.equal(h.client.puts.length,1);
  const saved=h.client.data.workouts.find(w=>w.id===result.records[0].workout_id);
  assert.equal(saved.entries[1].planned.sec,25);assert.equal(saved.bridgeSession.active_seconds,60);
});

test('Native body preview validates units, aggregates same-day weights, preserves private data, detects conflicts',async t=>{
  const h=await harness(t);h.client.data.bwDaily='avg';
  const privateWeight=await h.call('record_body_feedback',{date:'2000-01-03',body_weight:60,unit:'kg',feedback:'Synthetic'});
  const weight=(time,value)=>({kind:'weight',date:'2000-01-04',time,value,unit:'kg'});
  const invalid={kind:'circumference',date:'2000-01-04',value:20,unit:'kg',field:'waist'};
  await assert.rejects(()=>h.call('preview_body_sync',{items:[invalid]}));
  assert.equal(h.bridge.writer.proposals.size,0);assert.equal(h.client.puts.length,0);assert.equal(h.backups.length,0);
  const items=[weight('08:00',60),weight('12:00',62),{...invalid,value:30,unit:'in'}];
  const preview=await h.call('preview_body_sync',{items,private_weight_ids:[privateWeight.record_id]});
  assert.equal(preview.changes[1].daily_weight,61);assert.equal(preview.changes[2].value,76.2);
  assert.equal(h.client.puts.length,0);
  assert.equal((await h.call('apply_body_sync',approve(preview))).verified,true);
  const read=await h.call('get_native_body_data',{from:'2000-01-03',to:'2000-01-04'});
  assert.equal(read.weights[1].readings.length,2);assert.equal(read.weights[1].daily_weight,61);
  assert.equal(read.measurements[0].fields.waist,76.2);
  const duplicate=await h.call('preview_body_sync',{items,private_weight_ids:[privateWeight.record_id]});
  assert.equal(duplicate.proposal_id,null);assert(duplicate.changes.every(item=>item.status==='duplicate'));
  const conflict=await h.call('preview_body_sync',{items:[weight('08:00',61)]});
  assert.equal(conflict.proposal_id,null);assert.equal(conflict.changes[0].status,'conflict');
  assert.equal(h.client.puts.length,1);assert.equal(h.backups.length,1);
});

test('Structured feedback keeps missing and explicit none distinct and drives escaped chart data',async t=>{
  const h=await harness(t);
  const d=await h.call('start_workout_draft',{date:'2000-01-03',name:'Synthetic'});
  await h.call('record_session_feedback',{draft_id:d.draft_id,questionnaire:{skipped:true}});
  await h.call('record_session_feedback',{workout_id:'w1',exercise_feedback:{exercise_index:0}});
  await h.call('record_session_feedback',{workout_id:'w1',exercise_feedback:{exercise_index:0,discomfort:'none'}});
  await h.call('record_session_feedback',{workout_id:'w1',exercise_feedback:{exercise_index:0,discomfort:'reported',pain_sites:['<Example>']}});
  const out=await h.call('list_session_feedback');
  assert(out.records.some(r=>r.discomfort===null));assert(out.records.some(r=>r.discomfort==='none'));
  const chart=await h.call('get_training_trend',{metric:'discomfort',from:'2000-01-01',to:'2000-01-03'});
  assert.match(chart.svg,/&lt;Example&gt;/);assert.doesNotMatch(chart.svg,/<Example>/);
  assert.equal(chart.series[0].points[0].value,1);
  assert.equal(h.client.puts.length,0);assert.equal(h.backups.length,0);
});

test('V1.4.5 workout projection preserves distance, bands, tempo and circuit scores through note edits',async t=>{
  const h=await harness(t),w=h.client.data.workouts[0];
  const set={mode:'distance',m:15,w:4,done:true,bands:['synthetic-blue'],tempo:'3-1-1-0'};
  w.entries[0].sets.push(set);
  w.circuits=[{mode:'amrap',rounds:2,extra:3,sec:50,ids:['a'],roundTimes:[20,21]}];
  const out=await h.call('get_workout',{workout_id:w.id});
  assert.equal(out.exercises[0].sets[1].distance_m,15);
  assert.deepEqual(out.exercises[0].sets[1].band_ids,set.bands);
  assert.equal(out.exercises[0].sets[1].tempo,set.tempo);
  assert.deepEqual(out.circuit_results[0].round_times_seconds,[20,21]);
  await assert.rejects(()=>h.call('preview_workout_edit',{workout_id:w.id,actions:[{type:'remove_set',exercise_index:0,set_index:1}]}),e=>e.code==='unsupported');
  assert.equal(h.bridge.writer.proposals.size,0);assert.equal(h.client.puts.length,0);assert.equal(h.backups.length,0);
  const preview=await h.call('preview_workout_edit',{workout_id:w.id,actions:[{type:'set_note',note:'Synthetic note'}]});
  await h.call('apply_workout_edit',approve(preview));
  assert.deepEqual(h.client.data.workouts[0].entries[0].sets[1],set);
  assert.deepEqual(h.client.data.workouts[0].circuits,w.circuits);
});

test('Wrapped catalogue parser decodes quoted names as data and preserves historical muscle model',()=>{
  const rows=Array.from({length:1001},(_,i)=>({id:'s'+i,n:i?'Synthetic '+i:"Synthetic person's drill",bp:'back',tg:'rear delts'}));
  const wrapped="export const EXDB=JSON.parse('"+JSON.stringify(rows).replaceAll("'","\\'")+"');";
  assert.deepEqual(extractCatalogueArray(wrapped),rows);
  assert.throws(()=>extractCatalogueArray("export const EXDB=JSON.parse(makePayload());"));
  const catalogue=buildCatalogue(rows,{s0:{muscleWeights:{'rear-delts':1,lats:0}}},{s0:{name:'虚构'}});
  assert.deepEqual(weightsForEntry({},catalogue,{id:'s0'}).weights,{'rear-delts':1,lats:0});
  assert.deepEqual(weightsForEntry({},catalogue,{id:'s0',muscleSnapshot:{muscleWeights:{deltoids:.5,'upper-back':1}}}).weights,{deltoids:.5,'upper-back':1});
});

test('Catalogue proposal detects tampering, verifies candidate again, and backs up exact old bytes',async t=>{
  const h=await harness(t),file=path.join(h.directory,'catalogue.json');
  const previous=JSON.stringify({source:'Synthetic old',names:{a:'Old'},exercises:{a:{n:'Old'}}});
  const next={source:'Synthetic new',names:{a:'New',b:'B'},exercises:{a:{n:'New'},b:{n:'B'}}};
  await fs.writeFile(file,previous);
  let candidate=next;
  const refresh=new CatalogueRefresh(file,h.bridge.writer,async()=>{
    if(!candidate)throw new Error('Digest check failed');
    return candidate;
  });
  let preview=await refresh.preview();
  assert.equal(preview.changes.renamed.count,1);assert.equal(preview.changes.added.count,1);
  candidate=null;
  await assert.rejects(()=>refresh.apply(approve(preview)),/Digest check failed/);
  assert.equal(await fs.readFile(file,'utf8'),previous);
  candidate=next;
  preview=await refresh.preview();
  await fs.writeFile(file,previous+'\n');
  await assert.rejects(()=>refresh.apply(approve(preview)),e=>e.code==='conflict');
  assert.equal(await fs.readFile(file,'utf8'),previous+'\n');
  await fs.writeFile(file,previous);
  preview=await refresh.preview();
  const result=await refresh.apply(approve(preview));
  assert.equal(await fs.readFile(path.join(h.directory,result.backup),'utf8'),previous);
  assert.deepEqual(JSON.parse(await fs.readFile(file)),next);
  assert.equal(h.client.puts.length,0);
});

test('Timed-plan and rest edits stay inside the existing approval and CAS boundary',async t=>{
  const h=await harness(t);
  h.client.data.routines[0].ex=[{id:'t',sets:1,mode:'time',sec:25,side:true,prog:'off'}];
  const action={type:'set_exercise_target',routine_id:'r',exercise_index:0,seconds:33,rest_sec:90,warmup_rest_sec:25,side_rest_sec:12};
  await assert.rejects(()=>h.call('preview_plan_change',{actions:[{...action,seconds:0}]}));
  assert.equal(h.bridge.writer.proposals.size,0);assert.equal(h.backups.length,0);
  const preview=await h.call('preview_plan_change',{actions:[action]});
  assert.equal(h.client.puts.length,0);
  assert.equal((await h.call('apply_plan_change',approve(preview))).verified,true);
  const {opening_targets:[target]}=await h.call('preview_planned_session',{time_zone:'Asia/Shanghai',routine_ids:['r']});
  assert.deepEqual(target.opening_rows,[{seconds:33,weight:0,side:'L'},{seconds:33,weight:0,side:'R'}]);
  assert.equal(target.opening.work_rest_seconds,90);
  assert.equal(target.opening.warmup_rest_seconds,25);
  assert.equal(target.opening.side_rest_seconds,12);
});

test('Native body preview is bound to account, revision and exact confirmation',async t=>{
  const h=await harness(t);
  const p=await h.call('preview_body_sync',{items:[{kind:'weight',date:'2000-01-04',value:61,unit:'kg'}]});
  await assert.rejects(()=>h.call('apply_body_sync',{proposal_id:p.proposal_id}));
  h.client.data._wid='synthetic-new-device';h.client.rev++;
  await assert.rejects(()=>h.call('apply_body_sync',approve(p)),error=>error.code==='conflict');
  assert.equal(h.backups.length,0);assert.equal(h.client.puts.length,0);
});

test('A planned draft keeps incomplete occurrences in the report but only records actual completed results',async t=>{
  const h=await harness(t);
  h.client.data.routines[0].ex=[{id:'a',sets:2,reps:6,weight:4,prog:'off'},{id:'t',sets:1,mode:'time',sec:25,prog:'off'}];
  let draft=await h.call('start_planned_workout',{time_zone:'Asia/Shanghai',routine_ids:['r']});
  const edit=(name,input)=>h.call(name,{draft_id:draft.draft_id,expected_revision:draft.revision,...input});
  draft=await edit('draft_add_set',{exercise_index:0,set:{reps:3,weight:3,phase:'warmup'}});
  for(let i=0;i<3;i++)draft=await edit('draft_add_set',{exercise_index:0,set:{reps:6,weight:4}});
  draft=await edit('draft_session_clock',{action:'end'});
  const preview=await h.call('preview_finish_workout_draft',{draft_id:draft.draft_id});
  assert.equal(preview.completion.completed_sets,3);assert.equal(preview.completion.extra_sets,1);
  assert.equal(preview.completion.completion_rate,2/3);assert.equal(preview.completion.unfinished[0].exercise_id,'t');
  assert.equal(preview.records[0].exercises.length,1);
  assert.equal(h.client.puts.length,0);assert.equal(h.backups.length,0);
});
