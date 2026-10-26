import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildCatalogue,importCatalogue,loadExerciseCatalogue,CATALOGUE_SOURCE} from '../src/catalogue.mjs';

// Synthetic text/metadata, deliberately not an upstream catalogue fixture.
const rows=()=>Array.from({length:1001},(_,i)=>({id:'s'+i,n:'Synthetic exercise '+i,tg:'pectorals',sm:['triceps'],media:'never imported'}));
const overlay=()=>({s1:{primaries:['upper-back'],secondaries:['chest','triceps'],muscleWeights:{'upper-back':1,biceps:.4,chest:0,triceps:0}}});
const chinese={s1:{name:'虚构动作'}};
const responses=()=>({'frontend/src/lib/exercises-data.js':'export const EXDB='+JSON.stringify(rows())+';',
 'frontend/src/lib/exercise-muscle-map.json':JSON.stringify(overlay()),'catalogue/i18n/zh.json':JSON.stringify(chinese)});
const fixtureDigests=source=>Object.fromEntries(Object.entries(source).map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')]));
test('Importer pins an immutable v1.4.2 commit, merges zero weights and excludes media',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-catalogue-041-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'catalogue.json'),calls=[],source=responses();
 const result=await importCatalogue(file,{digests:fixtureDigests(source),fetchImpl:async url=>{
  const root=`https://raw.githubusercontent.com/DuarteSantos8/openGym/${CATALOGUE_SOURCE.commit}/`;assert(url.startsWith(root));
  calls.push(url.slice(root.length));return new Response(source[url.slice(root.length)],{status:200});
 }});
 assert.deepEqual(calls,Object.keys(source));assert.equal(result.source_version,'1.4.2');
 const saved=JSON.parse(await fs.readFile(file));assert.equal(saved.format,3);assert.equal(saved.source_commit,CATALOGUE_SOURCE.commit);
 assert.equal(saved.names.s1,'虚构动作');assert.equal(saved.exercises.s1.muscleWeights.chest,0);assert.equal(saved.exercises.s1.muscleWeights.triceps,0);
 assert.deepEqual(saved.exercises.s1.primaries,['upper-back']);assert.equal(saved.exercises.s1.media,undefined);
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.equal((await loadExerciseCatalogue(file)).source_version,'1.4.2');
});
for(const [name,change] of [
 ['duplicate IDs',d=>d.push({...d[0]})],['missing name',d=>delete d[0].n],['invalid array',(_d,m)=>m.s1.primaries='chest'],
 ['negative weight',(_d,m)=>m.s1.muscleWeights.chest=-1],['string weight',(_d,m)=>m.s1.muscleWeights.chest='0'],
 ['oversized weight',(_d,m)=>m.s1.muscleWeights.chest=1.1],['unknown mapping target',(_d,m)=>m.missing={primaries:['chest']}],
 ['unknown overlay field',(_d,m)=>m.s1.media='not allowed'],['empty overlay',(_d,m)=>{for(const k of Object.keys(m))delete m[k];}],
 ['malformed translation',(_d,_m,c)=>c.s1.name=3],
])test('Catalogue schema rejects '+name,()=>{
 const d=rows(),m=overlay(),c=structuredClone(chinese);change(d,m,c);assert.throws(()=>buildCatalogue(d,m,c),/验证失败/);
});
for(const target of ['frontend/src/lib/exercises-data.js','frontend/src/lib/exercise-muscle-map.json','catalogue/i18n/zh.json'])
 for(const failure of ['HTTP','JSON'])test('Import '+failure+' failure preserves previous file: '+target,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-catalogue-refusal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'existing.json'),previous='{"names":{"old":"Synthetic old"}}\n';await fs.writeFile(file,previous);
  const source=responses();if(failure==='JSON')source[target]='bad payload';await assert.rejects(()=>importCatalogue(file,{digests:fixtureDigests(source),fetchImpl:async url=>{
   const key=Object.keys(source).find(k=>url.endsWith('/'+k));return new Response(key===target?'bad payload':source[key],{status:key===target&&failure==='HTTP'?503:200});
  }}));assert.equal(await fs.readFile(file,'utf8'),previous);assert.deepEqual(await fs.readdir(dir),['existing.json']);
 });
test('A structurally valid but incomplete response fails pinned digest verification without overwrite',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-catalogue-hash-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'existing.json');await fs.writeFile(file,'previous synthetic catalogue');
 await assert.rejects(()=>importCatalogue(file,{fetchImpl:async()=>new Response(JSON.stringify({s1:{primaries:['chest']}}))}),/摘要不匹配/);
 assert.equal(await fs.readFile(file,'utf8'),'previous synthetic catalogue');
});
test('A transport failure preserves the existing catalogue and leaves no temporary output',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-catalogue-network-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'existing.json');await fs.writeFile(file,'previous synthetic catalogue');
 await assert.rejects(()=>importCatalogue(file,{fetchImpl:async()=>{throw new Error('synthetic connection failure');}}));
 assert.equal(await fs.readFile(file,'utf8'),'previous synthetic catalogue');assert.deepEqual(await fs.readdir(dir),['existing.json']);
});
test('Names-only and v2 catalogues retain old reads without invented source metadata',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-catalogue-legacy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'legacy.json');await fs.writeFile(file,JSON.stringify({names:{a:'Synthetic'}}));
 assert.deepEqual(await loadExerciseCatalogue(file),{names:{a:'Synthetic'},exercises:{}});
 const c={names:{a:'Synthetic'},exercises:{a:{id:'a',n:'Synthetic',primaries:['chest']}}};await fs.writeFile(file,JSON.stringify({format:2,...c}));
 assert.deepEqual(await loadExerciseCatalogue(file),c);
});
