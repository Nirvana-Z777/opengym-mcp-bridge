import { randomUUID } from 'node:crypto';
import { PlanError } from './errors.mjs';
import { only, date, number, text, boundedOutput } from './validate.mjs';

export const circumferenceKeys = ['neck','shoulders','chest','waist','hips','abdomen','upperArmLeft','upperArmRight',
  'forearmLeft','forearmRight','wristLeft','wristRight','thighLeft','thighRight','calfLeft','calfRight','ankleLeft','ankleRight'];
const dailyMode = state => ['avg','last'].includes(state.bwDaily) ? state.bwDaily : 'first';
const rounding = (value, scale) => Math.round(value * scale) / scale;
const available = (state, key, row) => !(state.deleted?.[key]?.[row.d] > 0 && state.deleted[key][row.d] >= (row.t || 0));
const byTime = (a,b) => (a.at || '').localeCompare(b.at || '') || (a.t||0)-(b.t||0);

export function nativeReadings(day) {
  if (!Array.isArray(day.ins)) return Number.isFinite(day.w) && day.w>0 ? [{id:'0',at:null,w:day.w,t:day.t??0}] : [];
  const readings = new Map();
  for (const item of day.ins) {
    if (typeof item.id!=='string'||!Number.isFinite(item.w)||item.w<=0) continue;
    const removed = day.gone?.[item.id];
    if (removed>0 && removed >= (item.t||0)) continue;
    if (!readings.has(item.id) || (readings.get(item.id).t||0) < (item.t||0)) readings.set(item.id,item);
  }
  return [...readings.values()].sort(byTime);
}
function daily(readings, mode) {
  if (!readings.length) return null;
  if (mode==='avg') return rounding(readings.reduce((sum,r)=>sum+r.w,0)/readings.length,100);
  return (mode==='last'?readings.at(-1):readings[0]).w;
}
function bounds(input) {
  date(input.from); date(input.to);
  if (input.from>input.to || Date.parse(input.to)-Date.parse(input.from)>366*86400000)
    throw new PlanError('Expected an inclusive date range up to 366 days');
}
export function readBody(state, input) {
  bounds(input);
  const within = (key,row) => row.d>=input.from && row.d<=input.to && available(state,key,row);
  return boundedOutput({source:'opengym_native',from:input.from,to:input.to,weight_unit:state.unit==='lb'?'lb':'kg',
    measurement_unit:'cm',daily_mode:dailyMode(state),
    weights:(state.bodyweight||[]).filter(row=>within('bodyweight',row)).map(row=>{
      const readings=nativeReadings(row);
      return {date:row.d,daily_weight:daily(readings,dailyMode(state)),readings:readings.map(r=>({id:r.id,time:r.at??null,weight:r.w}))};
    }),
    measurements:(state.measurements||[]).filter(row=>within('measurements',row)).map(row=>({date:row.d,
      fields:Object.fromEntries(circumferenceKeys.filter(key=>Number.isFinite(row[key])).map(key=>[key,row[key]]))}))});
}

export function planBodySync(state, inputs, now) {
  const next=structuredClone(state);const changes=[];
  const find = (key,d) => {
    const rows=(next[key]??=[]);
    const same=rows.filter(row=>row.d===d);
    if(same.length>1||same.some(row=>!available(next,key,row))||(!same.length&&next.deleted?.[key]?.[d]>0))
      return {conflict:true};
    return {rows,row:same[0]};
  };
  for(const input of inputs){
    only(input,['kind','date','time','value','unit','field','record_id']);
    const d=date(input.date);
    if(input.kind==='weight'){
      if(input.field!==undefined)throw new PlanError('Weight has no measurement field');
      if(!['kg','lb'].includes(input.unit))throw new PlanError('Weight unit must be kg or lb');
      if(input.time!==undefined&&(typeof input.time!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)))throw new PlanError('Use HH:MM for local weighing time');
      const source=number(input.value,1,1500,'weight');
      const unit=state.unit==='lb'?'lb':'kg';
      const w=rounding(input.unit===unit?source:unit==='kg'?source/2.20462262185:source*2.20462262185,10);
      const details={kind:'weight',date:d,time:input.time??null,weight:w,unit,source_record_id:input.record_id??null};
      const {rows,row,conflict}=find('bodyweight',d);
      const readings=row?nativeReadings(row):[];
      const readingId=input.record_id ? 'bridge-'+input.record_id : randomUUID();
      const same=readings.find(r=>r.id===readingId || (r.w===w && (r.at??null)===details.time));
      const occupied=readings.some(r=>(r.at??null)===details.time);
      if(conflict||same&&same.w!==w||!same&&occupied){changes.push({...details,status:'conflict'});continue;}
      if(same){changes.push({...details,status:'duplicate'});continue;}
      if(row?.gone?.[readingId] || readings.length>=100){changes.push({...details,status:'conflict'});continue;}
      const stamp=Math.max(now,(row?.t||0)+1);
      const ins=[...readings,{id:readingId,at:details.time,w,t:stamp}].sort(byTime);
      const target={...row,d,ins,w:daily(ins,dailyMode(state)),t:stamp};
      if(row)rows[rows.indexOf(row)]=target;else rows.push(target);
      changes.push({...details,reading_id:readingId,status:'write',daily_weight:target.w,daily_mode:dailyMode(state)});
    }else if(input.kind==='circumference'){
      if(input.time!==undefined||input.record_id!==undefined||!circumferenceKeys.includes(input.field)||!['cm','in'].includes(input.unit))throw new PlanError('Expected a supported circumference field and cm or in');
      const cm=rounding(number(input.value,0.1,input.unit==='cm'?500:500/2.54,'circumference')*(input.unit==='in'?2.54:1),100);
      const {rows,row,conflict}=find('measurements',d);
      const details={kind:input.kind,date:d,field:input.field,value:cm,unit:'cm'};
      if(conflict||row?.[input.field]!=null&&row[input.field]!==cm){changes.push({...details,status:'conflict'});continue;}
      if(row?.[input.field]===cm){changes.push({...details,status:'duplicate'});continue;}
      const target={...row,d,[input.field]:cm,t:Math.max(now,(row?.t||0)+1)};
      if(row)rows[rows.indexOf(row)]=target;else rows.push(target);
      changes.push({...details,status:'write'});
    }else throw new PlanError('Unknown body sync item');
  }
  if(!changes.some(item=>item.status==='write'))return {next:state,changes};
  for(const key of ['bodyweight','measurements'])if(changes.some(item=>item.status==='write'&&(item.kind==='weight'?'bodyweight':'measurements')===key))next[key]?.sort((a,b)=>a.d.localeCompare(b.d));
  return {next,changes};
}

export function feedbackRecord(input, draft, workout) {
  const ref = draft ?? workout;
  if (!ref || Boolean(draft)===Boolean(workout)) throw new PlanError('Select one owned draft or saved workout');
  const pre=input.questionnaire;
  const feedback=input.exercise_feedback;
  if ((pre===undefined)===(feedback===undefined)) throw new PlanError('Select questionnaire or exercise feedback');
  if (pre) {
    if(!draft || pre.skipped===true&&Object.keys(pre).length!==1 || !Object.keys(pre).length)throw new PlanError('Questionnaire requires a draft and either answers or skipped=true');
    return {kind:'questionnaire',date:draft.date,draft_id:draft.draft_id,questionnaire:pre};
  }
  const entries=draft?.exercises ?? workout?.entries ?? [];
  const item=entries[feedback.exercise_index];
  if(!item)throw new PlanError('Unknown exercise occurrence');
  if(feedback.discomfort==='none'&&feedback.pain_sites?.length || feedback.discomfort==='reported'&&!feedback.pain_sites?.length)
    throw new PlanError('Discomfort and pain sites disagree');
  const distinct = [...new Set((feedback.pain_sites??[]).map(part=>text(part,50,'pain site')))];
  return {kind:'exercise_feedback',date:draft?.date??workout.d,draft_id:draft?.draft_id,workout_id:workout?.id,
    occurrence_id:item.occurrence_id??null,exercise_id:item.exercise_id??item.id,
    ...feedback,pain_sites:distinct,discomfort:feedback.discomfort??(distinct.length?'reported':null)};
}
