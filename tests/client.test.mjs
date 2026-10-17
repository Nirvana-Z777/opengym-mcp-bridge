import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OpenGymClient } from '../src/openGym.mjs';
import { extractCatalogueArray, importCatalogue, loadCatalogue } from '../src/catalogue.mjs';
// All identities, pairing codes, body weights, dates, and per-set values in this file are fictional test fixtures and are not from any user.

test('Pairing does not need password or cookie and stores bearer 0600',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-pair-test-'));
  const tokenFile=path.join(dir,'secrets','token.json');
  const reqs=[];
  const fakeFetch=async(url,init)=>{
    reqs.push({url,method:init.method,authorization:init.headers.Authorization,body:init.body});
    if(url.endsWith('/api/pair/redeem'))return Response.json({token:'fixture-only-initial-token',user:{name:'fictional-test-user'}});
    if(url.endsWith('/api/me'))return Response.json({user:{name:'fictional-test-user'},token:'fixture-only-refreshed-token'});
    if(url.endsWith('/api/data'))return Response.json({rev:2,state:{_rev:2,_wid:'fixture-write-id',routines:[],workouts:[],week:{}}});
    throw new Error('unknown route');
  };
  try{
    const client=new OpenGymClient({baseUrl:'https://test.invalid',tokenFile,fetchImpl:fakeFetch});
    const paired=await client.pair('AAAAAAAA');
    assert.equal(paired.name,'fictional-test-user');
    assert.equal(reqs[0].authorization,undefined);
    assert.deepEqual(JSON.parse(reqs[0].body),{code:'AAAAAAAA'});
    assert.equal((await stat(tokenFile)).mode & 0o777,0o600);
    assert.equal(JSON.parse(await readFile(tokenFile,'utf8')).token,'fixture-only-initial-token');
    const snap=await client.getData();
    assert.equal(snap.rev,2);
    assert.equal(reqs[1].authorization,'Bearer fixture-only-initial-token');
    assert.equal(reqs[2].authorization,'Bearer fixture-only-refreshed-token');
    assert.equal(JSON.parse(await readFile(tokenFile,'utf8')).token,'fixture-only-refreshed-token');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Official catalogue text is parsed without eval, names are imported',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-catalogue-test-'));
  const out=path.join(dir,'names.json');
  const data=Array.from({length:1002},(_,id)=>({id:String(id).padStart(4,'0'),n:`exercise ${id}`}));
  const js='// test\nexport const EXDB='+JSON.stringify(data)+';export const EXALIAS={};';
  const parsed=extractCatalogueArray(js);
  assert.equal(parsed.length,1002);
  const fakeFetch=async url=>new Response(url.includes('/i18n/zh.json')?JSON.stringify({'0001':{name:'俯卧撑'}}):js,{status:200});
  try{
    const result=await importCatalogue(out,{fetchImpl:fakeFetch});
    assert.equal(result.count,1002);
    assert.equal(result.translated,1);
    const names=await loadCatalogue(out);
    assert.equal(names['0001'],'俯卧撑');
    assert.equal(names['0002'],'exercise 2');
  } finally {await rm(dir,{recursive:true,force:true});}
});
