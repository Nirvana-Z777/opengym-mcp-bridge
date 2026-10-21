// Account-local durable documents. UUID filenames, private atomic writes and fail-closed mkdir locks.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PlanError } from './errors.mjs';
import { integer,isObject } from './validate.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class DraftStore {
 constructor(directory){if(!path.isAbsolute(directory)||directory==='/')throw new PlanError('Invalid store directory');this.directory=directory;}
 async init(){
  let parent=path.parse(this.directory).root;
  for(const part of path.resolve(this.directory).slice(parent.length).split(path.sep)){
   parent=path.join(parent,part);try{const st=await fs.lstat(parent);if(st.isSymbolicLink())throw new PlanError('Symlink store paths are forbidden');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(this.directory)!==path.resolve(this.directory))throw new PlanError('Symlink store paths are forbidden');
  await fs.chmod(this.directory,0o700);
 }
 file(id){if(typeof id!=='string'||!uuid.test(id))throw new PlanError('Invalid draft_id');return path.join(this.directory,id+'.json');}
 async get(id){
  await this.init();const handle=await fs.open(this.file(id),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>262144)throw new PlanError('Invalid stored document size/type');
   const value=JSON.parse(await handle.readFile('utf8'));
   if(!isObject(value)||value.schema_version!==1||value.draft_id!==id||!Number.isInteger(value.revision)||value.revision<1||!['open','committed','verification_pending','abandoned','recorded'].includes(value.status))throw new PlanError('Corrupt stored document');
   return value;
  }finally{await handle.close();}
 }
 async list(){
  await this.init();const names=await fs.readdir(this.directory);if(names.length>10000)throw new PlanError('Store exceeds document limit');
  const records=[];for(const name of names)if(uuid.test(name.slice(0,-5))&&name.endsWith('.json'))records.push(await this.get(name.slice(0,-5)));
  return records.sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||a.draft_id.localeCompare(b.draft_id));
 }
 async lock(id,fn){
  await this.init();const lock=path.join(this.directory,`.${id}.lock`);
  try{await fs.mkdir(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new PlanError('Store busy or crashed lock requires manual review','busy');throw e;}
  try{return await fn();}finally{await fs.rmdir(lock);}
 }
 async write(value){
  const dest=this.file(value.draft_id),temp=path.join(this.directory,`.${value.draft_id}.${randomUUID()}.tmp`);let handle;
  try{
   const data=JSON.stringify(value)+'\n';if(Buffer.byteLength(data)>262144)throw new PlanError('Document exceeds 256 KiB');
   handle=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   await handle.writeFile(data);await handle.sync();await handle.close();handle=null;await fs.rename(temp,dest);
   const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
  }finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 async create(data,status='open'){
  return this.lock('create',async()=>{
   const all=await this.list();if(all.length>=10000||all.filter(d=>d.status==='open').length>=50)throw new PlanError('Store/draft limit reached');
   const time=new Date().toISOString(),value={...structuredClone(data),schema_version:1,draft_id:randomUUID(),revision:1,status,created_at:time,updated_at:time};
   await this.write(value);return value;
  });
 }
 async edit(id,revision,fn,statuses=['open']){
  this.file(id);integer(revision,1,1000000000,'expected_revision');
  return this.lock(id,async()=>{
   const current=await this.get(id);if(current.revision!==revision)throw new PlanError('Draft revision changed','conflict');
   if(!statuses.includes(current.status))throw new PlanError('Draft is locked: '+current.status,'locked');
   await fn(current);current.revision++;current.updated_at=new Date().toISOString();await this.write(current);return current;
  });
 }
}
