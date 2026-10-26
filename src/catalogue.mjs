#!/usr/bin/env node
/* Optional catalogue-name importer. Downloads official TEXT only, never images/GIF/MP4. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';
import { configFromEnv } from './config.mjs';
import { writeCredential } from './openGym.mjs';

export const CATALOGUE_SOURCE=Object.freeze({version:'1.4.2',commit:'e9a303877d02e4237b183f96a9a6603990e8fafb',repository:'DuarteSantos8/openGym'});
const ROOT=`https://raw.githubusercontent.com/${CATALOGUE_SOURCE.repository}/${CATALOGUE_SOURCE.commit}/`;
export const CATALOGUE_DIGESTS=Object.freeze({
 'frontend/src/lib/exercises-data.js':'c95191c9fc41ed5937d5bf0d8a25c0ccb5cd5ab8519f32cb6e283c4f6e5bfb10',
 'frontend/src/lib/exercise-muscle-map.json':'568e83b15b0a30d07843720a49389e206d0e1436711865f27eb63192ab580fb9',
 'catalogue/i18n/zh.json':'4d04d1a2f55affc0ad8da460a2a94eeac73177310d08d86317920df0e8fd476f',
});
const map=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const label=v=>typeof v==='string'&&v.length>0&&v.length<=300&&!/[\u0000-\u001f]/.test(v);
const fail=message=>{throw new Error('官方动作目录验证失败：'+message);};
const safeSet=(target,key,value)=>Object.defineProperty(target,key,{value,enumerable:true,configurable:true,writable:true});
function metadata(raw){
  if(!map(raw))fail('动作元数据必须是对象');
  const out={};
  for(const key of ['id','n','bp','eq','tg','mg'])if(Object.hasOwn(raw,key)){
    if(!label(raw[key])&&!(key==='mg'&&raw[key]===''))fail('无效文字字段 '+key);out[key]=raw[key];
  }
  if(Object.hasOwn(raw,'assisted')){if(typeof raw.assisted!=='boolean')fail('assisted');out.assisted=raw.assisted;}
  for(const key of ['sm','primaries','secondaries','muscleGroups'])if(Object.hasOwn(raw,key)){
    if(!Array.isArray(raw[key])||raw[key].length>80||!raw[key].every(label))fail(key);out[key]=[...raw[key]];
  }
  if(Object.hasOwn(raw,'muscleWeights')){
    if(!map(raw.muscleWeights)||!Object.keys(raw.muscleWeights).length)fail('muscleWeights');
    const weights={};
    for(const [muscle,weight] of Object.entries(raw.muscleWeights)){
      if(!/^[a-z][a-z -]{0,79}$/.test(muscle)||typeof weight!=='number'||!Number.isFinite(weight)||weight<0||weight>1)fail('muscleWeights.'+muscle);
      safeSet(weights,muscle,weight); // An explicit zero is data, not absence.
    }
    out.muscleWeights=weights;
  }
  return out;
}

// Independently implemented projection of the published text metadata contract.
// The caller supplies data; no upstream implementation or dataset is bundled.
export function buildCatalogue(data,muscleMap,translations,source=CATALOGUE_SOURCE){
  if(!Array.isArray(data)||data.length<1000)fail('动作数量异常');
  if(!map(muscleMap)||!Object.keys(muscleMap).length)fail('肌群映射为空或结构无效');
  if(!map(translations)||!Object.keys(translations).length)fail('中文名称为空或结构无效');
  const names={},exercises={};
  for(const row of data){
    if(!map(row)||!label(row.id)||row.id.length>100||!label(row.n)||Object.hasOwn(names,row.id))fail('动作 ID/名称重复或无效');
    safeSet(names,row.id,row.n);safeSet(exercises,row.id,metadata(row));
  }
  for(const [id,overlay] of Object.entries(muscleMap)){
    if(!Object.hasOwn(exercises,id)||!map(overlay)||!Object.keys(overlay).length)fail('肌群映射目标无效 '+id);
    if(Object.keys(overlay).some(k=>!['bp','primaries','secondaries','muscleWeights'].includes(k)))fail('未知肌群映射字段');
    exercises[id]={...exercises[id],...metadata(overlay)};
  }
  let translated=0;
  for(const [id,entry] of Object.entries(translations))if(Object.hasOwn(names,id)){
    if(!map(entry)||!label(entry.name))fail('中文名称无效 '+id);
    safeSet(names,id,entry.name);translated++;
  }
  if(!translated)fail('没有匹配的中文名称');
  return {format:3,source:`openGym v${source.version} (text only)`,source_version:source.version,source_commit:source.commit,
    source_files:Object.keys(CATALOGUE_DIGESTS),
    count:Object.keys(names).length,translated,names,exercises};
}

// Scan a JavaScript file for the JSON array assigned to EXDB without eval / executing JS.
export function extractCatalogueArray(text){
  const anchor='export const EXDB=';
  const at=text.indexOf(anchor);
  if(at<0)throw new Error('找不到 EXDB，官方文件格式可能已变化');
  const start=text.indexOf('[',at+anchor.length);
  if(start<0)throw new Error('找不到 EXDB 的起始方括号');
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(escaped)escaped=false;
      else if(ch==='\\')escaped=true;
      else if(ch==='"')quoted=false;
      continue;
    }
    if(ch==='"'){quoted=true;continue;}
    if(ch==='[')depth++;
    else if(ch===']'){
      depth--;
      if(depth===0){
        const data=JSON.parse(text.slice(start,i+1));
        if(!Array.isArray(data)||data.length<1000)throw new Error('EXDB 内容数量异常');
        return data;
      }
    }
  }
  throw new Error('EXDB JSON 数组没有结束');
}

export async function loadCatalogue(file){
  return (await loadExerciseCatalogue(file)).names;
}
export async function loadExerciseCatalogue(file){
  try{
    const obj=JSON.parse(await fs.readFile(file,'utf8'));
    return {names:obj?.names && typeof obj.names==='object'&&!Array.isArray(obj.names)?obj.names:{},
      exercises:obj?.exercises && typeof obj.exercises==='object'&&!Array.isArray(obj.exercises)?obj.exercises:{},
      ...(obj?.source_version?{source_version:obj.source_version,source_commit:obj.source_commit}:{} )};
  }catch{return {names:{},exercises:{}};}
}

// digests is dependency injection for synthetic unit fixtures; the CLI always uses the pins.
export async function importCatalogue(file,{fetchImpl=globalThis.fetch,digests=CATALOGUE_DIGESTS}={}){
  const read=async name=>{
    const res=await fetchImpl(ROOT+name,{signal:AbortSignal.timeout(60000)});
    if(!res.ok)throw new Error(`${name}: HTTP ${res.status}`);
    const body=await res.text();
    if(createHash('sha256').update(body).digest('hex')!==digests[name])throw new Error(`${name}: 官方固定文件摘要不匹配，保留现有目录`);
    return body;
  };
  const data=extractCatalogueArray(await read('frontend/src/lib/exercises-data.js'));
  const muscleMap=JSON.parse(await read('frontend/src/lib/exercise-muscle-map.json'));
  const cn=JSON.parse(await read('catalogue/i18n/zh.json'));
  const catalogue=buildCatalogue(data,muscleMap,cn);
  catalogue.source_digests={...digests};
  // Every required fetch and schema check finishes before touching the existing file.
  await fs.mkdir(path.dirname(file),{recursive:true});
  await writeCredential(file,catalogue);
  return {count:catalogue.count,translated:catalogue.translated,source_version:catalogue.source_version,source_commit:catalogue.source_commit};
}

const entryFile = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if(entryFile === fileURLToPath(import.meta.url)) {
  const cfg=configFromEnv();
  try {
    const stats=await importCatalogue(cfg.catalogueFile);
    console.log(`动作文字目录导入完成：${stats.count} 个动作，${stats.translated} 个中文名称；未下载图片或动画。`);
  }catch(e){console.error('导入失败：'+e.message);process.exitCode=1;}
}
