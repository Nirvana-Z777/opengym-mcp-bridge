#!/usr/bin/env node
/* Optional catalogue-name importer. Downloads official TEXT only, never images/GIF/MP4. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './config.mjs';
import { writeCredential } from './openGym.mjs';

const RELEASE='v1.4.1';
const ROOT=`https://raw.githubusercontent.com/DuarteSantos8/openGym/${RELEASE}/`;

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
      exercises:obj?.exercises && typeof obj.exercises==='object'&&!Array.isArray(obj.exercises)?obj.exercises:{}};
  }catch{return {names:{},exercises:{}};}
}

export async function importCatalogue(file,{fetchImpl=globalThis.fetch}={}){
  const read=async name=>{
    const res=await fetchImpl(ROOT+name,{signal:AbortSignal.timeout(60000)});
    if(!res.ok)throw new Error(`${name}: HTTP ${res.status}`);
    return res.text();
  };
  const data=extractCatalogueArray(await read('frontend/src/lib/exercises-data.js'));
  const names=Object.fromEntries(data.map(row=>[row.id,row.n]).filter(([id,name])=>id && typeof name==='string'));
  const exercises=Object.fromEntries(data.filter(e=>typeof e.id==='string'&&typeof e.n==='string').map(e=>[e.id,
    Object.fromEntries(Object.entries(e).filter(([k,v])=>['id','n','bp','eq','tg','assisted'].includes(k)
      ? ['string','boolean'].includes(typeof v) : ['sm','primaries','secondaries','muscleGroups'].includes(k)&&Array.isArray(v)&&v.every(x=>typeof x==='string')))]));
  let translated=0;
  try{
    const cn=JSON.parse(await read('catalogue/i18n/zh.json'));
    for(const [id,entry] of Object.entries(cn)) {
      if(typeof entry?.name==='string'&&entry.name.trim()&&Object.hasOwn(names,id)){
        names[id]=entry.name;translated++;
      }
    }
  }catch(e){ console.error('[catalogue] 获取中文名称失败，使用官方英文名称：'+e.message); }
  await fs.mkdir(path.dirname(file),{recursive:true});
  await writeCredential(file,{format:2,source:`openGym ${RELEASE} (text only)`,count:Object.keys(names).length,translated,names,exercises});
  return {count:Object.keys(names).length,translated};
}

const entryFile = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if(entryFile === fileURLToPath(import.meta.url)) {
  const cfg=configFromEnv();
  try {
    const stats=await importCatalogue(cfg.catalogueFile);
    console.log(`动作文字目录导入完成：${stats.count} 个动作，${stats.translated} 个中文名称；未下载图片或动画。`);
  }catch(e){console.error('导入失败：'+e.message);process.exitCode=1;}
}
