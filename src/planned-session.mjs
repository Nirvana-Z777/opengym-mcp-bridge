import { PlanError } from './errors.mjs';
import { date, integer, number } from './validate.mjs';
import { assisted, basisOf, exerciseMetadata, hasCompletedSet, modeOf, normalizeSet, phaseOf } from './workout-data.mjs';

const ids = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
const visible = (state, kind, item) => {
  const key = item.id ?? (kind === 'workouts' ? item.d + '|' + item.start : '');
  const stamp = state.deleted?.[kind]?.[key] ?? 0;
  return !item.deleted && !item.undone && !(stamp > 0 && stamp >= (item._ts || item.end || item.start || 0));
};

export function localDate(instant, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant);
    return ['year','month','day'].map(type => parts.find(part => part.type === type).value).join('-');
  } catch { throw new PlanError('Expected a valid IANA time zone'); }
}

export function resolvePlan(state, input, now) {
  const today = localDate(now, input.time_zone);
  const day = input.date === undefined ? today : date(input.date);
  const routines = new Map((state.routines || []).filter(r => visible(state,'routines',r)).map(r => [r.id,r]));
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
  const own = ids(state.week?.[weekday]).filter(id => routines.has(id));
  const override = state.dayPlan?.[day];
  const queue = state.queue;
  const queueStart = queue?.startsOn || (queue?.since > 0 ? localDate(queue.since, input.time_zone) : null);
  const queued = queueStart && (!queue.strict || queue.since > 0)
    ? [...new Set(ids(queue.ids))].filter(id => routines.has(id)) : [];
  const remaining = queued.filter(id => !(state.workouts || []).some(workout => {
    if (!visible(state,'workouts',workout) || !ids(workout.routineIds ?? workout.routineId).includes(id)) return false;
    if (queue.since > 0 && workout.start >= queue.since) return true;
    const name = routines.get(id).name;
    return !queue.strict && workout.d >= queueStart && workout.d <= today
      && typeof name === 'string' && (' + ' + workout.name + ' + ').includes(' + ' + name + ' + ');
  }));
  const queueDay = queueStart && day === (queueStart > today ? queueStart : today);
  const pinned = remaining.includes(override);
  const next = queueDay ? remaining.find(id => !Object.entries(state.dayPlan || {}).some(([d,key]) => d >= today && key === id)) : null;
  let matches, source;
  if (override === 'rest') { matches = []; source = 'rest_override'; }
  else if (routines.has(override) && !queued.includes(override)) { matches = [override]; source = 'override'; }
  else if (pinned || next) { matches = [pinned ? override : next, ...own.filter(id => !queued.includes(id))]; source = pinned ? 'pinned' : 'coach'; }
  else { matches = queueDay && remaining.length ? own.filter(id => !queued.includes(id)) : own; source = matches.length ? 'weekday' : 'rest'; }
  const explanation = {weekday:'Weekly schedule',rest:'No routine on this date',rest_override:'Explicit rest-day override',
    override:'One-off routine override',pinned:'Pinned rotation session plus weekday routines',coach:'Next unfinished rotation session plus weekday routines'};
  const selected = input.routine_ids ?? matches;
  if (input.routine_ids && (new Set(selected).size !== selected.length || selected.some(id => !routines.has(id))))
    throw new PlanError('Select distinct existing routine IDs');
  const ambiguous = (override !== undefined && override !== 'rest' && !routines.has(override))
    || ids(state.week?.[weekday]).some(id => !routines.has(id));
  return { date:day, today, time_zone:input.time_zone, source, reason:explanation[source], ambiguous,
    needs_choice:ambiguous && !input.routine_ids,
    routine_ids:matches, routine_names:matches.map(id=>routines.get(id).name), selected: selected.map(id=>routines.get(id)) };
}

const scalarFields = ['sets','reps','weight','sec','restSec','warmupRestSec','warmupRestOff','sideRestSec','sideRestOff','restOff','warmupSets','mode','side','dbLoad','prog'];
const targetOf = cfg => Object.fromEntries(scalarFields.filter(k => ['string','number','boolean'].includes(typeof cfg[k])).map(k=>[k,cfg[k]]));
const unsupported = ['pyramid','intensifier','bands','backoff','circuit','subs','sg','warmupRows','warmupSets'];
export function openTargets(state, routines, catalogue, day) {
  const result = [];
  for (const routine of routines) {
    for (const [index,cfg] of (routine.ex || []).entries()) {
      const template = targetOf(cfg);
      const mode = cfg.mode || (cfg.sec != null ? 'time' : 'reps');
      const basis = basisOf({target:{dbLoad:cfg.dbLoad ?? state.dbLoad?.[cfg.id]?.mode}});
      const plan = { ...template, mode, sets:integer(cfg.sets ?? 1,1,30,'planned sets') };
      const rule = routine.excludeFromProgression ? 'off' : cfg.prog || routine.prog || (mode==='time'?'off':state.progDefault || 'linear');
      const recurrence = (state.workouts || []).filter(w => w.d <= day && visible(state,'workouts',w)).flatMap(w =>
        (w.entries || []).filter(e => e.id === cfg.id && !e.noProg && !w.excludeFromProgression && e.sets?.some(s=>phaseOf(s)==='work'&&hasCompletedSet(s)))
          .map(e=>({e,w,matched:ids(w.routineIds ?? w.routineId).includes(routine.id)||e.rid===routine.id})))
        .sort((a,b)=>(state.lastFrom==='any'?0:Number(a.matched)-Number(b.matched))||a.w.d.localeCompare(b.w.d)||(a.w.start??0)-(b.w.start??0));
      const previous = recurrence.at(-1);
      const last = previous?.e;
      let source = 'routine_plan';
      if (!['reps','time'].includes(mode) || unsupported.some(k => cfg[k] && (!Array.isArray(cfg[k]) || cfg[k].length))
          || routine.type && routine.type !== 'standard' || state.programme || state.deloadCycle?.every>0 || state.deloadCycle?.extra?.length
          || !['off','linear'].includes(rule) || assisted(state,catalogue,cfg) && rule!=='off'
          || (cfg.warmup!=='none' && ['auto','own'].includes(cfg.warmup)) || (cfg.warmup!=='none' && ['all','compounds'].includes(state.warmupAuto))
          || (last && (rule!=='off'||state.startFrom==='last') && basisOf(last)!==basis)) {
        throw new PlanError('This routine uses opening targets the Bridge cannot reproduce safely. Start it in openGym.', 'unsupported');
      }
      if (last && !routine.excludeFromProgression && (rule !== 'off' || state.startFrom === 'last')) {
        const rows = last.sets.filter(s=>modeOf(s,last)===mode&&phaseOf(s)==='work'&&hasCompletedSet(s));
        if (rows.length) {
          // These targets are suitable for the Bridge draft. Complex prescriptions stay in the App.
          if (Number.isFinite(rows[0].w)) plan.weight = rows[0].w;
          if (state.startFrom === 'last' && mode==='reps' && Number.isInteger(rows[0].r)) plan.reps=rows[0].r;
          if (mode==='time' && Number.isInteger(rows[0].sec)) plan.sec=rows[0].sec;
          source = 'last_session';
          if (rule==='linear' && mode==='reps') {
            const prior = last.planned;
            const changed = prior && ['sets','reps','repsMin','setsMax','sec'].some(key=>(prior[key]??null)!==(cfg[key]??null));
            const borrowed = !previous.matched && state.lastFrom!=='any';
            if (changed || borrowed) {
              plan.reps=cfg.reps;
              if (prior && prior.weight!==cfg.weight && cfg.weight>0) plan.weight=cfg.weight;
              source='plan_changed';
            } else {
              const lastGoal=last.target?.reps??cfg.reps;
              const count=last.target?.sets??cfg.sets??1;
              const work=last.sets.filter(s=>phaseOf(s)==='work');
              const examined=(last.target?work.slice(0,count):work);
              const meta=exerciseMetadata(state,catalogue,cfg.id);
              const supported=!!meta && plan.weight>0 && !cfg.side && !cfg.bodyweight &&
                !state.gymSplit?.[cfg.id] && !state.dumbbells?.[state.unit]?.weights?.length && !state.dumbbells?.[state.unit]?.length &&
                !state.machineStacks?.[cfg.id] && !last.target?.backoffStep && !last.target?.rowReps?.length &&
                !examined.some(s=>s.bands?.length||s.type&&s.type!=='straight'||s.sides||modeOf(s,last)!=='reps') &&
                examined.filter(hasCompletedSet).every(s=>s.w===plan.weight);
              if (!supported || examined.length<count || !examined.every(s=>s.done===true&&s.r>=lastGoal))
                throw new PlanError('Opening progression needs the App for stalled, mixed-load, or equipment-specific history', 'unsupported');
              const unit=state.unit==='lb'?'lb':'kg';
              const heavier=['upper legs','lower legs','back','hips','glutes'].includes(meta.bp);
              const defaultStep=(unit==='lb'?5:2.5)*(heavier?2:1);
              const configured=state.wstep?.[unit];
              const step=cfg.inc>0?cfg.inc:configured>0&&configured<=50?Number(configured):defaultStep;
              const value=plan.weight;
              const onGrid=Math.abs(value-Math.round(value/step)*step)<=Math.min(.1,step/4)+1e-9;
              plan.weight=Number((onGrid?(Math.round(value/step)+1)*step:value+step).toFixed(3));
              source='progression';
            }
          }
        }
      } else if (last && mode==='reps' && !plan.weight && Number.isFinite(last.sets.find(s=>s.done&&phaseOf(s)==='work')?.w)) {
        plan.weight=last.sets.find(s=>s.done&&phaseOf(s)==='work').w; source='last_session';
      } else if (rule !== 'off' && state.exWeights?.[cfg.id]?.w > 0) {
        plan.weight=state.exWeights[cfg.id].w; source='confirmed_weight';
      }
      plan.work_rest_seconds=cfg.restSec>0?cfg.restSec:cfg.restOff===true?0:state.restSec??null;
      plan.warmup_rest_seconds=cfg.warmupRestOff===true?0:cfg.warmupRestSec>0?cfg.warmupRestSec:state.warmupRestSec??plan.work_rest_seconds;
      plan.side_rest_seconds=cfg.sideRestOff===true?0:cfg.sideRestSec>0?cfg.sideRestSec:null;
      if (mode==='time') integer(plan.sec,1,86400,'planned seconds');
      else integer(plan.reps,1,1000,'planned reps');
      if (plan.weight!==undefined) number(plan.weight,0,1000,'planned weight');
      const plannedRows=mode==='time'&&plan.side?plan.sets*2:plan.sets;
      integer(plannedRows,1,30,'planned rows');
      const openingRows=Array.from({length:plannedRows},(_,i)=>mode==='time'
        ? {seconds:plan.sec,weight:plan.weight??0,...(plan.side?{side:i%2?'R':'L'}:{})}
        : plan.side
          ? {sides:{L:{reps:Math.ceil(plan.reps/2),weight:plan.weight??0},R:{reps:Math.floor(plan.reps/2),weight:plan.weight??0}}}
          : {reps:plan.reps,weight:plan.weight??0});
      result.push({ occurrence_id:routine.id+':'+index, routine_id:routine.id, exercise_id:cfg.id, weight_basis:basis,
        template, opening:plan, opening_rows:openingRows, exclude_from_progression:routine.excludeFromProgression===true, source, explanation:{routine_plan:'Routine template',confirmed_weight:'Confirmed working load',
          last_session:'Last eligible session, preferring this routine',plan_changed:'Reset to the new plan after a template change or first use of this routine',progression:'All target sets reached their rep goal at the previous load'}[source] });
    }
  }
  if (result.length < 1 || result.length > 30) throw new PlanError('The selected plans must contain 1–30 exercise occurrences');
  return result;
}

export function sessionClock(timer, action, now) {
  if (!timer) throw new PlanError('This legacy draft has no session clock');
  if (now < timer.changed_at) throw new PlanError('System clock moved backwards', 'conflict');
  const expected = {pause:'running',resume:'paused',end:timer.status}[action];
  if (timer.status==='ended' || timer.status!==expected) throw new PlanError('Invalid clock transition');
  const elapsed = timer.active_ms + (timer.status==='running' ? now-timer.changed_at : 0);
  return { ...timer, active_ms:elapsed, changed_at:now, status:{pause:'paused',resume:'running',end:'ended'}[action] };
}

export function completion(draft) {
  const rows = draft.exercises.map((exercise,index) => {
    const target = draft.opening_targets?.find(t=>t.occurrence_id===exercise.occurrence_id);
    const count = exercise.sets.map(normalizeSet).filter(s=>phaseOf(s)==='work'&&hasCompletedSet(s)).length;
    return {exercise_index:index,occurrence_id:exercise.occurrence_id,exercise_id:exercise.exercise_id,
      planned:target?.opening_rows?.length??target?.opening.sets??0,completed:count,extra:Math.max(0,count-(target?.opening_rows?.length??target?.opening.sets??0))};
  });
  for (const target of draft.opening_targets || []) if (!rows.some(row=>row.occurrence_id===target.occurrence_id))
    rows.push({exercise_index:null,occurrence_id:target.occurrence_id,exercise_id:target.exercise_id,planned:target.opening_rows?.length??target.opening.sets,completed:0,extra:0});
  const planned=rows.reduce((sum,row)=>sum+row.planned,0);
  const completed=rows.reduce((sum,row)=>sum+row.completed,0);
  return {planned_sets:planned,completed_sets:completed,
    completion_rate:planned?rows.reduce((sum,row)=>sum+Math.min(row.planned,row.completed),0)/planned:null,
    extra_sets:rows.reduce((sum,row)=>sum+row.extra,0), unfinished:rows.filter(row=>row.completed<row.planned),
    occurrences:rows, total_seconds:(draft.clock.changed_at-draft.clock.started_at)/1000,
    active_seconds:draft.clock.active_ms/1000, method:'Work rows only. A reps row with either side completed counts once. Timed sides are individual rows. Extra rows do not increase plan completion.'};
}
