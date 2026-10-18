import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileBackupStore } from '../src/backup.mjs';
import { fixture } from './fixtures.mjs';
const temporary=async fn=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-fictional-backup-'));try{await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}};
test('Backup is parseable, atomic, private, and returns metadata only',async()=>temporary(async dir=>{
  const directory=path.join(dir,'backups');const store=new FileBackupStore({directory});const state=fixture();
  const result=await store.create({state,rev:4},'workout_edit');
  const files=await fs.readdir(directory);assert.deepEqual(files,[result.id]);
  const saved=JSON.parse(await fs.readFile(path.join(directory,result.id),'utf8'));
  assert.deepEqual(saved.state,state);assert.equal(saved.revision,4);assert.equal(saved.write_id,state._wid);assert.equal(saved.operation,'workout_edit');assert.ok(saved.created_at);
  assert.equal((await fs.stat(directory)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(directory,result.id))).mode&0o777,0o600);
  assert.equal(result.state,undefined);assert.equal(result.token,undefined);
}));
test('Retention keeps 20 backups and never deletes unrelated files or symlinks',async()=>temporary(async dir=>{
  await fs.writeFile(path.join(dir,'unrelated.json'),'preserve');await fs.mkdir(path.join(dir,'unrelated-directory'));
  await fs.symlink(path.join(dir,'unrelated.json'),path.join(dir,'unrelated-link'));
  let now=946684800000;const store=new FileBackupStore({directory:dir,now:()=>now++});let last;
  for(let i=0;i<23;i++)last=await store.create({state:fixture(),rev:4},'plan');
  const files=await fs.readdir(dir);assert.equal(files.filter(f=>f.startsWith('opengym-backup-')).length,20);assert.ok(files.includes(last.id));
  assert.equal(await fs.readFile(path.join(dir,'unrelated.json'),'utf8'),'preserve');assert.equal((await fs.lstat(path.join(dir,'unrelated-link'))).isSymbolicLink(),true);
}));
test('Identical backup timestamps cannot evict the just-created preimage',async()=>temporary(async dir=>{
  const store=new FileBackupStore({directory:dir,keep:1,now:()=>946684800000});
  for(let i=0;i<8;i++){const result=await store.create({state:fixture(),rev:4},'plan');assert.deepEqual(await fs.readdir(dir),[result.id]);}
}));
test('Atomic rename failure leaves no partially published backup',async()=>temporary(async dir=>{
  const store=new FileBackupStore({directory:dir,io:{...fs,rename:async()=>{throw new Error('synthetic storage failure');}}});
  await assert.rejects(()=>store.create({state:fixture(),rev:4},'plan'),e=>e.code==='backup-failed');assert.deepEqual(await fs.readdir(dir),[]);
}));
test('Credentials in state are refused before serialization; secret response fields are excluded',async()=>temporary(async dir=>{
  const store=new FileBackupStore({directory:dir});
  for(const key of ['token','api_key','Authorization','runtimeApiKey','password','cookie']){
    const state=fixture();state.opaque[key]='synthetic-value';await assert.rejects(()=>store.create({state,rev:4},'plan'),e=>e.code==='backup-failed');
  }
  const result=await store.create({state:fixture(),rev:4,token:'synthetic-response-only'},'plan');
  assert.ok(!(await fs.readFile(path.join(dir,result.id),'utf8')).includes('synthetic-response-only'));
}));
test('A symlink backup directory is rejected and its target is not modified',async()=>temporary(async dir=>{
  const target=path.join(dir,'target');await fs.mkdir(target);const link=path.join(dir,'link');await fs.symlink(target,link);
  const store=new FileBackupStore({directory:link});await assert.rejects(()=>store.create({state:fixture(),rev:4},'plan'),e=>e.code==='backup-failed');assert.deepEqual(await fs.readdir(target),[]);
}));
