import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approve, customCreate, catalogue } from './fixtures.mjs';
test('Create maps validated custom metadata into native fields with a stable generated ID',async()=>{
  const {bridge,client}=setup();const p=await bridge.previewCustomExerciseChange({actions:[customCreate]});
  assert.equal(client.data.customEx.length,0);const id=p.changes[0].exercise_id;assert.ok(id.startsWith('c'));
  await bridge.applyCustomExerciseChange(approve(p));const e=client.data.customEx[0];assert.equal(e.id,id);assert.equal(e.custom,true);assert.equal(e.n,customCreate.name);
  assert.deepEqual(e.primaries,['upper-back']);assert.deepEqual(e.secondaries,['biceps']);assert.deepEqual(e.sm,['biceps']);assert.equal(e.tg,'upper-back');assert.deepEqual(e.muscleGroups,['upper-back','biceps']);
  const listed=await bridge.listCustomExercises();assert.equal(listed.exercises[0].description,'虚构说明');
  assert.equal((await bridge.searchExercises({query:customCreate.name})).results[0].exercise_id,id);
});
test('Existing exact custom/official matches return an existing ID with no write proposal',async()=>{
  const {bridge,client}=setup();const first=await bridge.previewCustomExerciseChange({actions:[customCreate]});await bridge.applyCustomExerciseChange(approve(first));
  const duplicate=await bridge.previewCustomExerciseChange({actions:[{...customCreate,name:'  SYNTHETIC custom movement  '}]});
  assert.equal(duplicate.changed,false);assert.equal(duplicate.proposal_id,null);assert.equal(duplicate.existing[0].exercise_id,client.data.customEx[0].id);
  const official=await bridge.previewCustomExerciseChange({actions:[{type:'create',name:catalogue.exercises.a.n,body_part:'chest',equipment:'dumbbell'}]});
  assert.equal(official.existing[0].exercise_id,'a');assert.equal(official.changed,false);assert.equal(client.puts.length,1);
});
test('Ambiguous duplicate metadata and rename collisions are refused',async()=>{
  const {bridge}=setup();const p=await bridge.previewCustomExerciseChange({actions:[customCreate]});const id=p.changes[0].exercise_id;await bridge.applyCustomExerciseChange(approve(p));
  for(const change of [{equipment:'barbell'},{primary_muscles:['chest']},{description:'不同的虚构说明'}])await assert.rejects(()=>bridge.previewCustomExerciseChange({actions:[{...customCreate,...change}]}),e=>e.code==='duplicate');
  await assert.rejects(()=>bridge.previewCustomExerciseChange({actions:[{type:'update',exercise_id:id,name:catalogue.exercises.a.n}]}),e=>e.code==='duplicate');
});
test('Rename preserves references, unknown fields, media and synchronization metadata',async()=>{
  const {bridge,client}=setup();const p=await bridge.previewCustomExerciseChange({actions:[customCreate]});await bridge.applyCustomExerciseChange(approve(p));
  const e=client.data.customEx[0];e.media={image:'synthetic-media-id'};e._ts=3;e._f={n:3};e.extension={retain:true};
  client.data.routines[0].ex[0].id=e.id;client.data.workouts[0].entries[0].id=e.id;
  const q=await bridge.previewCustomExerciseChange({actions:[{type:'update',exercise_id:e.id,name:'Synthetic renamed custom',equipment:'cable',primary_muscles:['upper-back','biceps'],secondary_muscles:[],description:'新的虚构说明'}]});
  assert.equal(q.changes[0].after.reference_count,2);await bridge.applyCustomExerciseChange(approve(q));
  const saved=client.data.customEx[0];assert.equal(saved.id,e.id);assert.deepEqual(saved.media,e.media);assert.deepEqual(saved.extension,e.extension);assert.deepEqual(saved._f,e._f);
  assert.equal(client.data.routines[0].ex[0].id,e.id);assert.equal(client.data.workouts[0].entries[0].id,e.id);
});
test('Custom vocabulary, bounds, overlap and unsupported operations are checked',async()=>{
  const {bridge}=setup();
  for(const action of [{...customCreate,body_part:'invalid'},{...customCreate,equipment:'invalid'},{...customCreate,primary_muscles:['invalid']},{...customCreate,secondary_muscles:['upper-back']},{...customCreate,name:'x'.repeat(81)},{...customCreate,description:'x'.repeat(1001)},{type:'delete',exercise_id:'a'}])await assert.rejects(()=>bridge.previewCustomExerciseChange({actions:[action]}));
  const p=await bridge.previewCustomExerciseChange({actions:[{type:'create',name:'Synthetic cardio movement',body_part:'cardio',equipment:'body weight'}]});
  assert.deepEqual(p.changes[0].after.primary_muscles,['cardiovascular system']);
});
test('Custom list is bounded and read-only, excludes extensions with authentication data',async()=>{
  const {bridge,client}=setup();client.data.customEx=Array.from({length:3},(_,i)=>({id:'c'+i,n:'Synthetic '+i,bp:'back',eq:'cable',token:'synthetic-private-extension'}));
  const first=await bridge.listCustomExercises({limit:2});assert.equal(first.exercises.length,2);assert.equal(first.next_offset,2);assert.equal(first.total,3);
  assert.equal((await bridge.listCustomExercises({offset:2,limit:2})).exercises.length,1);assert.ok(!JSON.stringify(first).includes('synthetic-private-extension'));assert.equal(client.puts.length,0);
  await assert.rejects(()=>bridge.listCustomExercises({limit:101}));
});
test('Names-only legacy catalogue remains readable but cannot authorize incomplete duplicate checks',async()=>{
  const {bridge}=setup({loadCatalogue:async()=>({names:catalogue.names,exercises:{}})});
  assert.equal((await bridge.searchExercises({query:'press'})).results.length,1);
  await assert.rejects(()=>bridge.previewCustomExerciseChange({actions:[customCreate]}),e=>e.code==='catalogue-required');
});
