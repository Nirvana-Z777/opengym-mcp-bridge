#!/usr/bin/env node
import { configFromEnv } from './config.mjs';
import { OpenGymClient } from './openGym.mjs';
import { PersonalGymBridge } from './plan.mjs';
import { loadCatalogue } from './catalogue.mjs';

const cfg=configFromEnv();
const bridge=new PersonalGymBridge({client:new OpenGymClient(cfg),writes:cfg.writes,loadNames:()=>loadCatalogue(cfg.catalogueFile)});
try {
  const result=process.argv.includes('--plan')?await bridge.getPlan():await bridge.getStatus();
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error('检查失败：'+e.message);process.exitCode=1;}
