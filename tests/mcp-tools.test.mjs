import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dispatch, listTools } from '../src/mcp.mjs';
import { configFromEnv } from '../src/config.mjs';
import { setup } from './fixtures.mjs';
test('All 11 original tools and 8 new tools have schemas; every formal writer is gated',async()=>{
  const old=['search','fetch','get_status','get_summary','get_plan','get_recent_workouts','search_exercises','preview_plan_change','apply_plan_change','preview_workout_log','log_workout'];
  const all=listTools(true);assert.equal(all.length,19);assert.equal(new Set(all.map(t=>t.name)).size,19);assert.equal(listTools(false).length,15);
  for(const name of old)assert.ok(all.some(t=>t.name===name));
  for(const name of ['apply_plan_change','log_workout','apply_custom_exercise_change','apply_workout_edit'])assert.ok(!listTools(false).some(t=>t.name===name));
  for(const t of all){assert.equal(t.inputSchema.type,'object');assert.equal(t.inputSchema.additionalProperties,false);assert.doesNotThrow(()=>JSON.stringify(t));}
  const {bridge}=setup({writes:false});const disabled=await dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_workout_edit',arguments:{}}},bridge);assert.equal(disabled.error.code,-32602);
});
test('New read/preview MCP routes return structured content without making writes',async()=>{
  const {bridge,client}=setup();
  for(const [name,args] of [['list_custom_exercises',{}],['list_workouts',{}],['get_workout',{workout_id:'w1'}],['get_exercise_history',{exercise_id:'a'}],['preview_workout_edit',{workout_id:'w1',actions:[{type:'set_note',note:'虚构新备注'}]}]]){
    const reply=await dispatch({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}},bridge);assert.equal(reply.result.isError,false,JSON.stringify(reply));assert.ok(reply.result.structuredContent);
  }
  assert.equal(client.puts.length,0);
});
test('Backup config defaults to the existing store sibling and rejects unsafe retention values',()=>{
  const previous={...process.env};try{
    process.env.OPENGYM_BASE_URL='https://test.invalid';process.env.CATALOGUE_NAMES_FILE='/synthetic-store/exercise-names.json';delete process.env.OPENGYM_BACKUP_DIR;delete process.env.OPENGYM_BACKUP_KEEP;
    const cfg=configFromEnv();assert.equal(cfg.backupDirectory,'/synthetic-store/backups');assert.equal(cfg.backupKeep,20);
    process.env.OPENGYM_BACKUP_KEEP='0';assert.throws(()=>configFromEnv());
  }finally{for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});
test('Development PR retains published version until separately approved release',async()=>{
  const info=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));const lock=JSON.parse(await fs.readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
  assert.equal(info.version,lock.version);assert.equal(info.version,lock.packages[''].version);
});
