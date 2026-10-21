// Opt-in acceptance against an external, unmodified official checkout. No production URL,
// configuration, credential or export is accepted. Upstream AGPL sources stay outside this repo.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { OpenGymClient } from '../src/openGym.mjs';
import { extractCatalogueArray } from '../src/catalogue.mjs';

const PIN = '464355ef43d4c8f8a4e0bb6db9c2af7f240593b5';
const upstream = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'Usage: node scripts/acceptance-official.mjs /external/openGym [--keep]');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(), PIN);
assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(), '', 'Official tracked files must be unmodified');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opengym-official-acceptance-'));
await fs.chmod(dir, 0o700);
const report = { upstream: { version: '1.4.1', commit: PIN }, bridge_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, checks: [], requests: [] };
const children = new Set();
const env = { PATH: process.env.PATH, NODE_ENV: 'test' };
let proxy, mcp, apiUrl, cookie, frontendProbe, dropAfterAccept = false, raceBeforePut = false;
let id = 0;
const pending = new Map();
const output = path.resolve('acceptance-results.json');
async function shutdown() {
  for (const child of children) child.kill('SIGKILL');
  proxy?.closeAllConnections(); proxy?.close();
  if (frontendProbe) await fs.rm(frontendProbe, { force: true });
  await fs.rm(dir, { recursive: true, force: true });
}
process.once('SIGTERM', async () => { await shutdown(); process.exit(0); });
async function raw(method, endpoint, body, expected = 200) {
  const r = await fetch(apiUrl + endpoint, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4173', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(r.status, expected, method + ' ' + endpoint);
  const value = await r.json();
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  return value;
}
async function startMcp() {
  mcp = spawn(process.execPath, ['src/mcp.mjs'], { cwd: root, env: { ...env, OPENGYM_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, OPENGYM_TOKEN_FILE: path.join(dir, 'paired.json'), CATALOGUE_NAMES_FILE: path.join(dir, 'catalogue.json'), OPENGYM_BACKUP_DIR: path.join(dir, 'backups'), OPENGYM_BACKUP_KEEP: '100', OPENGYM_ALLOW_WRITES: '1', MCP_TRANSPORT: 'stdio' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(mcp);
  createInterface({ input: mcp.stdout }).on('line', line => { const r = JSON.parse(line); pending.get(r.id)?.(r); pending.delete(r.id); });
  const init = await rpc('initialize'); assert.equal(init.serverInfo.name, 'personal-opengym-bridge');
}
async function rpc(method, params) {
  const requestId = ++id;
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP response timeout')); }, 25000);
    pending.set(requestId, r => { clearTimeout(timer); resolve(r); });
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  const r = await reply; if (r.error) throw new Error(r.error.message);
  return r.result;
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.isError) { const e = JSON.parse(r.content[0].text); throw Object.assign(new Error(e.error), { code: e.code }); }
  return r.structuredContent;
}
const approval = p => ({ proposal_id: p.proposal_id, confirmation: '我确认写入' });
const puts = () => report.requests.filter(r => r.method === 'PUT').length;
const snapshot = () => raw('GET', '/api/data');
async function check(name, fn) {
  const before = puts();
  await fn();
  report.checks.push({ name, passed: true, bridge_puts: puts() - before });
  console.log('PASS ' + name);
}
async function nativeEdit(fn) {
  const before = await snapshot(), next = structuredClone(before.state); fn(next);
  next._ts = stampChange(before.state, next);
  await raw('PUT', '/api/data', { state: next, baseRev: before.rev, baseWid: before.state._wid, stamped: true });
  return snapshot();
}
let stampChange, mergeStates, entryRoutineId, workoutVolume;
try {
  const api = spawn(process.execPath, ['server.js'], { cwd: path.join(upstream, 'api'), env: { ...env, PORT: '0', DATA_DIR: path.join(dir, 'official'), PASSWORD_LOGIN: '1', FIRST_USER_ADMIN: '0', ORIGIN: 'http://localhost:4173', RP_ID: 'localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(api);
  apiUrl = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Official API boot timeout')), 10000);
    api.stdout.on('data', d => { log += d; const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(timer); resolve('http://127.0.0.1:' + m[1]); } });
    api.once('exit', () => { clearTimeout(timer); reject(new Error('Official API failed to start')); });
  });
  proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    if (req.method === 'PUT' && raceBeforePut) {
      raceBeforePut = false;
      await nativeEdit(s => { s.dayPlan['2026-10-25'] = 'rest'; });
    }
    const r = await fetch(apiUrl + req.url, { method: req.method, headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, ...(['POST', 'PUT'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
    const body = await r.text(); report.requests.push({ method: req.method, endpoint: req.url, status: r.status });
    if (req.method === 'PUT' && dropAfterAccept) { dropAfterAccept = false; res.destroy(); return; }
    res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(body);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  ({ stampChange, mergeStates } = await import(pathToFileURL(path.join(upstream, 'frontend/src/lib/sync-merge.js'))));
  ({ entryRoutineId, workoutVolume } = await import(pathToFileURL(path.join(upstream, 'frontend/src/lib/history.js'))));
  const exdb = extractCatalogueArray(await fs.readFile(path.join(upstream, 'frontend/src/lib/exercises-data.js'), 'utf8'));
  const names = Object.fromEntries(exdb.map(e => [e.id, e.n]));
  const exercises = Object.fromEntries(exdb.map(e => [e.id, e]));
  await fs.writeFile(path.join(dir, 'catalogue.json'), JSON.stringify({ names, exercises }), { mode: 0o600 });
  const picks = ['barbell bench press', 'barbell squat', 'barbell bent over row'].map(n => exdb.find(e => e.n.toLowerCase() === n));
  assert(picks.every(Boolean), 'Pinned official exercise IDs must be found');
  const [bench, squat, row] = picks.map(e => e.id);
  await check('isolated account registration and official one-time pairing', async () => {
    await raw('POST', '/api/register/password', { name: 'Bridge Acceptance Synthetic', password: 'Synthetic-only-acceptance-2026!' });
    const paired = new OpenGymClient({ baseUrl: `http://127.0.0.1:${proxy.address().port}`, tokenFile: path.join(dir, 'paired.json') });
    const code = (await raw('POST', '/api/pair/create')).code; await paired.pair(code);
    await raw('POST', '/api/pair/redeem', { code }, 400);
    assert.equal((await snapshot()).state, null);
    await raw('PUT', '/api/data', { state: { unit: 'kg', routines: [], week: {}, dayPlan: {}, workouts: [], customEx: [], bodyweight: [], exWeights: {}, syntheticExtension: { preserve: true } }, baseRev: 0 });
    await startMcp(); assert.equal((await rpc('tools/list')).tools.length, 37);
    assert.equal((await call('get_status')).connected, true);
  });
  let plans;
  await check('A/B/C creation: preview, explicit confirmation, one PUT, backup and reread', async () => {
    const before = await snapshot(), p = await call('preview_plan_change', { actions: ['A', 'B', 'C'].map((name, i) => ({ type: 'create_routine', name: 'Synthetic ' + name, weekdays: [i + 1], exercises: [{ exercise_id: [bench, bench, squat][i], sets: 2, reps: 5, weight: 2 }] })) });
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(() => call('apply_plan_change', { proposal_id: p.proposal_id }));
    const n = puts(), r = await call('apply_plan_change', approval(p)); assert.equal(r.verified, true); assert.equal(puts(), n + 1);
    plans = (await call('get_plan')).routines; assert.equal(plans.length, 3);
    const backups = await fs.readdir(path.join(dir, 'backups')); assert.equal(backups.length, 1);
    const file = path.join(dir, 'backups', backups[0]); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(file)).state, before.state);
  });
  await check('existing plan rename, add, reorder, replace, target edit and remove exercise', async () => {
    const p = await call('preview_plan_change', { actions: [
      { type: 'rename_routine', routine_id: plans[0].id, name: 'Synthetic A revised' },
      { type: 'add_routine_exercise', routine_id: plans[0].id, exercise: { exercise_id: row, sets: 2, reps: 6 } },
      { type: 'move_routine_exercise', routine_id: plans[0].id, exercise_index: 1, to_index: 0 },
      { type: 'replace_routine_exercise', routine_id: plans[0].id, exercise_index: 1, exercise: { exercise_id: squat, sets: 1, reps: 5 } },
      { type: 'set_exercise_target', routine_id: plans[0].id, exercise_index: 0, weight: 3, reps: 8 },
      { type: 'remove_routine_exercise', routine_id: plans[0].id, exercise_index: 1 }
    ] });
    assert.equal((await call('apply_plan_change', approval(p))).verified, true);
    const a = (await call('get_plan')).routines[0]; assert.equal(a.id, plans[0].id); assert.equal(a.exercises.length, 1); assert.equal(a.exercises[0].exercise_id, row); assert.equal(a.exercises[0].reps, 8);
    assert.deepEqual((await snapshot()).state.syntheticExtension, { preserve: true });
  });
  await check('real concurrent official write invalidates preview without PUT or retry', async () => {
    const p = await call('preview_plan_change', { actions: [{ type: 'rename_routine', routine_id: plans[1].id, name: 'Must not overwrite' }] });
    await nativeEdit(s => { s.routines[1].name = 'Synthetic B from official client'; });
    await assert.rejects(() => call('apply_plan_change', approval(p)), e => e.code === 'conflict');
    assert.equal((await snapshot()).state.routines[1].name, 'Synthetic B from official client');
  });
  await check('mandatory backup filesystem failure refuses the write before network submission', async () => {
    const p = await call('preview_plan_change', { actions: [{ type: 'rename_routine', routine_id: plans[0].id, name: 'Must not apply without backup' }] });
    const folder = path.join(dir, 'backups'), held = folder + '-held';
    await fs.rename(folder, held);
    try {
      await fs.writeFile(folder, 'synthetic obstruction', { mode: 0o600 });
      await assert.rejects(() => call('apply_plan_change', approval(p)), e => e.code === 'backup-failed');
    } finally { await fs.rm(folder, { force: true }); await fs.rename(held, folder); }
    assert.equal((await snapshot()).state.routines[0].name, 'Synthetic A revised');
  });
  await check('real official HTTP 409 after final preflight is consumed once without retry', async () => {
    const p = await call('preview_plan_change', { actions: [{ type: 'rename_routine', routine_id: plans[0].id, name: 'Must not apply over racing writer' }] });
    raceBeforePut = true; const n = puts();
    await assert.rejects(() => call('apply_plan_change', approval(p)), e => e.code === 'conflict');
    assert.equal(puts(), n + 1); assert.equal(report.requests.at(-1).status, 409);
    await assert.rejects(() => call('apply_plan_change', approval(p))); assert.equal(puts(), n + 1);
    assert.equal((await snapshot()).state.dayPlan['2026-10-25'], 'rest');
    assert.equal((await snapshot()).state.routines[0].name, 'Synthetic A revised');
  });
  const draftEdit = (d, name, args = {}) => call(name, { draft_id: d.draft_id, expected_revision: d.revision, ...args });
  const saved = [];
  for (let i = 0; i < 3; i++) await check('linked draft ' + 'ABC'[i] + ': persistence, actual sets, approval, single commit and duplicate refusal', async () => {
    const before = await snapshot();
    let d = await call('start_workout_draft', { date: '2026-10-' + (19 + i), name: 'Synthetic workout ' + 'ABC'[i], routine_id: plans[i].id });
    assert.equal(d.exercises.length, 0);
    d = await draftEdit(d, 'draft_add_exercise', { exercise_id: [row, bench, squat][i] });
    d = await draftEdit(d, 'draft_add_set', { exercise_index: 0, set: { weight: 2, reps: 3 } });
    if (i === 0) {
      mcp.stdin.end(); await once(mcp, 'exit'); children.delete(mcp); await startMcp();
      assert.deepEqual(await call('get_workout_draft', { draft_id: d.draft_id }), d);
      d = await draftEdit(d, 'draft_add_set', { exercise_index: 0, set: { weight: 1, reps: 1 } });
      d = await draftEdit(d, 'draft_update_set', { exercise_index: 0, set_index: 1, set: { weight: 3, reps: 4 } });
      d = await draftEdit(d, 'draft_set_note', { note: 'Synthetic recovery note' });
      d = await draftEdit(d, 'draft_set_routine', { routine_id: plans[1].id });
      d = await draftEdit(d, 'draft_set_routine', { routine_id: plans[0].id });
    }
    assert.deepEqual(await snapshot(), before);
    const p = await call('preview_finish_workout_draft', { draft_id: d.draft_id });
    assert.equal(p.records[0].routine_id, plans[i].id);
    assert.equal(p.total_sets, i === 0 ? 2 : 1);
    await assert.rejects(() => call('commit_finished_workout_draft', { proposal_id: p.proposal_id, confirmation: 'yes' }));
    assert.deepEqual(await snapshot(), before);
    const n = puts(), r = await call('commit_finished_workout_draft', approval(p)); assert.equal(r.verified, true); assert.equal(puts(), n + 1);
    await assert.rejects(() => call('commit_finished_workout_draft', approval(p))); assert.equal(puts(), n + 1);
    assert.equal((await call('get_workout_draft', { draft_id: d.draft_id })).status, 'committed');
    const w = (await snapshot()).state.workouts.find(w => w.id === p.records[0].workout_id);
    assert.equal(entryRoutineId(w, w.entries[0]), plans[i].id); assert.equal(workoutVolume(w), i === 0 ? 18 : 6);
    const read = await call('get_workout', { workout_id: w.id }); assert.equal(read.routine_id, plans[i].id);
    saved.push(w);
  });
  await check('draft correction invalidates an older finish preview; cancellation stays local', async () => {
    let d = await call('start_workout_draft', { date: '2026-10-21', name: 'Synthetic cancelled', routine_id: plans[0].id });
    d = await draftEdit(d, 'draft_add_exercise', { exercise_id: row });
    d = await draftEdit(d, 'draft_add_set', { exercise_index: 0, set: { weight: 2, reps: 3 } });
    const p = await call('preview_finish_workout_draft', { draft_id: d.draft_id });
    d = await draftEdit(d, 'draft_update_set', { exercise_index: 0, set_index: 0, set: { weight: 3, reps: 3 } });
    await assert.rejects(() => call('commit_finished_workout_draft', approval(p)), e => e.code === 'conflict');
    d = await draftEdit(d, 'draft_remove_set', { exercise_index: 0, set_index: 0 });
    d = await draftEdit(d, 'draft_remove_exercise', { exercise_index: 0 });
    d = await draftEdit(d, 'abandon_workout_draft'); assert.equal(d.status, 'abandoned');
    await assert.rejects(() => call('preview_finish_workout_draft', { draft_id: d.draft_id }));
  });
  await check('real server accepted write with dropped response: restart, read-only recovery, no second PUT', async () => {
    let d = await call('start_workout_draft', { date: '2026-10-18', name: 'Synthetic uncertain', routine_id: plans[0].id });
    d = await draftEdit(d, 'draft_add_exercise', { exercise_id: row });
    d = await draftEdit(d, 'draft_add_set', { exercise_index: 0, set: { weight: 1, reps: 2 } });
    const p = await call('preview_finish_workout_draft', { draft_id: d.draft_id });
    dropAfterAccept = true; const n = puts();
    assert.equal((await call('commit_finished_workout_draft', approval(p))).status, 'verification_pending'); assert.equal(puts(), n + 1);
    mcp.stdin.end(); await once(mcp, 'exit'); children.delete(mcp); await startMcp();
    assert.equal((await call('recover_workout_draft', { draft_id: d.draft_id })).recovered, true);
    assert.equal(puts(), n + 1); await assert.rejects(() => call('preview_finish_workout_draft', { draft_id: d.draft_id }));
  });
  const weekly = () => call('get_weekly_training_summary', { from: '2026-10-19', to: '2026-10-25' });
  await check('official history helpers and native deletion/Undo merge agree with bridge statistics', async () => {
    const before = await snapshot();
    let stats = await weekly(); assert.equal(stats.weeks[0].workouts, 3); assert.equal(stats.weeks[0].volume_by_weight_basis.as_recorded, 30);
    const deleted = await nativeEdit(s => { s.workouts = s.workouts.filter(w => w.id !== saved[0].id); });
    assert(deleted.state.deleted.workouts[saved[0].id] > 0);
    const merged = mergeStates(deleted.state, before.state); assert.equal(merged.workouts.some(w => w.id === saved[0].id), false);
    stats = await weekly(); assert.equal(stats.weeks[0].workouts, 2); assert.equal(stats.weeks[0].volume_by_weight_basis.as_recorded, 12);
    assert.equal((await call('get_workout_progress', { exercise_id: row, from: '2026-10-19', to: '2026-10-25' })).total, 0);
    const undone = await nativeEdit(s => { s.workouts.push(structuredClone(saved[0])); });
    assert(undone.state.deleted.workouts[saved[0].id] < 0);
    assert.equal(mergeStates(undone.state, deleted.state).workouts.filter(w => w.id === saved[0].id).length, 1);
    stats = await weekly(); assert.equal(stats.weeks[0].workouts, 3); assert.equal(stats.weeks[0].volume_by_weight_basis.as_recorded, 30);
    assert.equal((await call('get_workout_progress', { exercise_id: row, from: '2026-10-19', to: '2026-10-25' })).total, 1);
  });
  await check('official routine delete and Undo keep existing linked workouts and reject missing plan', async () => {
    const removed = (await snapshot()).state.routines[2];
    await nativeEdit(s => { s.routines = s.routines.filter(r => r.id !== removed.id); delete s.week[3]; });
    await assert.rejects(() => call('start_workout_draft', { date: '2026-10-21', name: 'Synthetic missing', routine_id: removed.id }));
    assert.equal((await call('get_workout', { workout_id: saved[2].id })).routine_id, removed.id);
    await nativeEdit(s => { s.routines.push(removed); s.week[3] = removed.id; });
    const d = await call('start_workout_draft', { date: '2026-10-21', name: 'Synthetic restored', routine_id: removed.id });
    await draftEdit(d, 'abandon_workout_draft');
  });
  await check('body weight and feedback persist locally without an official API write', async () => {
    const before = await snapshot();
    assert.equal((await call('record_body_feedback', { date: '2026-10-21', body_weight: 70, unit: 'kg', feedback: 'Synthetic only' })).synced_to_opengym, false);
    mcp.stdin.end(); await once(mcp, 'exit'); children.delete(mcp); await startMcp();
    assert.equal((await call('list_body_feedback')).total, 1); assert.deepEqual(await snapshot(), before);
  });
  await check('official frontend store synchronizes real API data and preserves Bridge history through delete/Undo', async () => {
    const destination = path.join(upstream, 'frontend/bridge-acceptance.test.jsx');
    await fs.copyFile(path.join(root, 'scripts/acceptance-frontend.test.jsx'), destination, fs.constants.COPYFILE_EXCL);
    frontendProbe = destination;
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'bridge-acceptance.test.jsx', '--reporter=json', '--outputFile=' + path.join(dir, 'frontend-results.json')], { cwd: path.join(upstream, 'frontend'), env: { ...env, ACCEPTANCE_API: apiUrl, ACCEPTANCE_COOKIE: cookie }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let log = ''; child.stdout.on('data', x => { log += x; }); child.stderr.on('data', x => { log += x; });
    const [status] = await once(child, 'exit'); children.delete(child);
    if (status !== 0) throw new Error('Official frontend integration failed: ' + log);
    const result = JSON.parse(await fs.readFile(path.join(dir, 'frontend-results.json'), 'utf8'));
    assert.equal(result.numPassedTests, 1); assert.equal(result.numFailedTests, 0);
    report.frontend = { environment: 'happy-dom, real api/useStore/sync modules and HTTP', passed: result.numPassedTests, browser_ui_verified: false };
    assert.equal((await call('get_plan')).routines[0].name, 'Synthetic A web sync');
    assert.equal((await weekly()).weeks[0].volume_by_weight_basis.as_recorded, 30);
    await fs.rm(frontendProbe); frontendProbe = null;
  });
  report.passed = true;
  report.finished_at = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Acceptance passed: ' + report.checks.length + ' checks; results: ' + output);
  if (process.argv.includes('--keep')) {
    await fs.writeFile(path.join(dir, 'ready.json'), JSON.stringify({ api_url: apiUrl, upstream, synthetic_account: 'Bridge Acceptance Synthetic' }));
    console.log('Isolated API ready for web verification: ' + apiUrl + '; temporary directory: ' + dir);
    await new Promise(() => {});
  }
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack };
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.error(error); process.exitCode = 1;
} finally { await shutdown(); }
