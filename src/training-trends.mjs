import { date, boundedOutput } from './validate.mjs';
import { PlanError } from './errors.mjs';

export function nextTrainingSuggestion(state, routine, exerciseIndex, records, unit, feedback=[], draftId) {
  const template = routine?.ex?.[exerciseIndex];
  if (!template) throw new PlanError('Select an existing routine occurrence');
  const candidates = records.filter(row => row.completed_work_sets > 0);
  const latest = candidates.at(-1);
  const basis = template.dbLoad ?? state.dbLoad?.[template.id]?.mode ?? 'as';
  const actualBasis = {as_recorded:'as',per_dumbbell:'each',pair_total:'total'}[latest?.weight_basis];
  const missing = [];
  if (!latest) missing.push('No completed work history');
  if (latest && basis !== actualBasis) missing.push('Latest history uses a different weight basis');
  if (latest?.assisted || template.side || template.sec || template.mode && template.mode!=='reps')
    missing.push('This type of exercise needs a manual progression decision');
  const target = {sets:template.sets??1,reps:template.reps??null,weight:template.weight??null};
  const workout=state.workouts?.find(w=>w.id===latest?.workout_id);
  const pre=feedback.find(r=>r.kind==='questionnaire'&&r.draft_id===draftId)?.questionnaire;
  const post=feedback.find(r=>r.kind==='exercise_feedback'&&r.exercise_id===template.id);
  if (!pre || pre.skipped || pre.recovery===undefined) missing.push('Recovery self-rating was not provided');
  const rows=latest?.sets.filter(s=>s.done&&s.phase==='work'&&s.mode==='reps'&&!s.sides&&!s.bands) ?? [];
  const efforts=rows.map(s=>s.rir).filter(Number.isFinite);
  if (efforts.length < (target.sets??1) && post?.rir===undefined) missing.push('RIR was not recorded for all target sets');
  const safeRows=rows.length>=target.sets && rows.slice(0,target.sets).every(s=>s.reps>=target.reps&&s.weight===rows[0].weight);
  const limited=post?.discomfort==='reported'||post?.reduced_difficulty===true||
    (pre?.recovery!==undefined&&pre.recovery<=2)||(pre?.fatigue!==undefined&&pre.fatigue>=4)||(pre?.soreness!==undefined&&pre.soreness>=4);
  const confirmedRir=efforts.length>=target.sets?Math.min(...efforts):post?.rir;
  const supported=missing.length===0&&safeRows&&target.reps>0&&target.reps<100&&Number.isFinite(rows[0]?.weight)&&!limited&&confirmedRir>=2;
  return {routine_id:routine.id,exercise_index:exerciseIndex,exercise_id:template.id,unit,weight_basis:latest?.weight_basis??null,
    target, evidence:{last_date:latest?.date??null,workout_id:latest?.workout_id??null,completed_sets:latest?.completed_work_sets??null,
      target_at_start:workout?.entries?.[latest?.exercise_index]?.target?.reps??null,
      actual_weight:rows[0]?.weight??null,actual_reps:rows.map(s=>s.reps),minimum_rir:confirmedRir??null,
      recovery:pre?.recovery??null,discomfort:post?.discomfort??null},missing,
    recommendation:supported?{sets:target.sets,reps:target.reps+1,weight:rows[0].weight}:null,
    reason:limited?'Maintain or review manually based on self-reported recovery/discomfort':
      supported?'Each target set reached its reps at a consistent load with at least two reps in reserve. Consider one more rep at that recorded load.':
      'Evidence does not support increasing the target.',
    requires_selection_and_formal_confirmation:true};
}

const escape = value => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
export function trendChart(label, unit, source, series, from, to) {
  date(from); date(to);
  const values=series.flatMap(s=>s.points.map(p=>p.value)).filter(Number.isFinite);
  const high=Math.max(1,...values);
  const timeSpan=Math.max(86400000,Date.parse(to)-Date.parse(from));
  const palettes=['#1262a2','#9d4328','#4c791a','#734bb2'];
  const chart=series.map((item,i)=>{
    const color=palettes[i%palettes.length];
    const markers=item.points.filter(p=>Number.isFinite(p.value)).map(p=>{
      const x=68+(Date.parse(p.date)-Date.parse(from))/timeSpan*638;
      const y=188-p.value/high*125;
      return '<circle cx="'+x.toFixed(2)+'" cy="'+y.toFixed(2)+'" r="3.5" fill="'+color+'"><title>'+escape(item.label+' '+p.date+' '+p.value)+'</title></circle>';
    }).join('');
    return markers+'<text x="68" y="'+(232+16*i)+'" fill="'+color+'">'+escape(item.label)+'</text>';
  }).join('');
  const height=244+16*series.length;
  return {label,unit,source,series,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 '+height+'" role="img">'+
    '<title>'+escape(label)+'</title><rect width="760" height="'+height+'" fill="white"/>'+
    '<g font-family="sans-serif" font-size="12" fill="#1c2730"><text x="20" y="22" font-size="17">'+escape(label)+'</text>'+
    '<text x="20" y="44">'+escape(unit+' · '+source)+'</text><path d="M 68 63 V 188 H 706" fill="none" stroke="#aab5bd"/>'+
    '<text x="22" y="70">'+escape(high.toFixed(1))+'</text><text x="50" y="190">0</text>'+
    '<text x="68" y="210">'+from+'</text><text x="640" y="210">'+to+'</text>'+
    (values.length?'':'<text x="290" y="128">No recorded data</text>')+chart+'</g></svg>'};
}

export function buildTrend(input, data) {
  const span=Date.parse(date(input.to))-Date.parse(date(input.from));
  if(span<0||span>90*86400000)throw new PlanError('Chart range must be 0–90 days');
  let label,unit,source,series;
  if(input.metric==='body_weight'){
    label='Daily body weight';unit=data.weight_unit;source='openGym daily '+data.daily_mode;
    series=[{label,points:data.weights.map(row=>({date:row.date,value:row.daily_weight}))}];
  }else if(input.metric==='exercise'){
    label='Best recorded work load';unit=data.unit;source='openGym completed work sets';
    series=Object.keys(data.totals_by_weight_basis).map(basis=>({label:basis,
      points:data.records.filter(r=>r.weight_basis===basis).map(r=>({date:r.date,value:r.best_load}))}));
  }else if(input.metric==='discomfort'){
    label='Reported discomfort by location';unit='reports';source='Bridge private exercise feedback';
    const days=new Map();
    for(const record of data){
      if(record.kind!=='exercise_feedback'||record.date<input.from||record.date>input.to||record.discomfort==null)continue;
      const values=days.get(record.date)??new Map();
      days.set(record.date,values);
      for(const site of record.pain_sites||[])values.set(site,(values.get(site)||0)+1);
    }
    const sites=[...new Set([...days.values()].flatMap(values=>[...values.keys()]))].slice(0,8);
    series=(sites.length?sites:['Explicit reports']).map(site=>({label:site,
      points:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,values])=>({date:day,value:values.get(site)??0}))}));
  }else{
    const volume = input.metric==='volume';
    label=volume?'Weekly external load volume':'Weekly effective sets by muscle';
    unit=volume?data.unit+' × reps':'effective sets';source='openGym saved workouts';
    const keys=[...new Set(data.weeks.flatMap(week=>Object.keys(volume?week.volume_by_weight_basis:week.muscles)))];
    const ordered=keys.sort((a,b)=>data.weeks.reduce((sum,w)=>sum+(w.muscles[b]?.effective_sets||0)-(w.muscles[a]?.effective_sets||0),0)).slice(0,8);
    series=ordered.map(key=>({label:key,points:data.weeks.map(week=>({date:week.week_start<input.from?input.from:week.week_start,
      value:volume?week.volume_by_weight_basis[key]??null:week.muscles[key]?.effective_sets??null}))}));
  }
  return boundedOutput({from:input.from,to:input.to,...trendChart(label,unit,source,series,input.from,input.to)});
}
