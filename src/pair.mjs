#!/usr/bin/env node
import { configFromEnv } from './config.mjs';
import { OpenGymClient } from './openGym.mjs';

const [code] = process.argv.slice(2);
if(!code){console.error('用法: node src/pair.mjs <网页里生成的8位一次性配对码>');process.exit(2);}
try {
  const result=await new OpenGymClient(configFromEnv()).pair(code);
  console.log('配对成功；用户：'+result.name+'。凭据已经安全保存到 secrets/。');
}catch(e){console.error('配对失败：'+e.message);process.exitCode=1;}
