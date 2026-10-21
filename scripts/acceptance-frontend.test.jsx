// @vitest-environment happy-dom
// Own acceptance probe, copied temporarily beside the official frontend's src directory.
// Uses the real api(), useStore and sync modules; only fetch's origin/cookie plumbing is
// adapted for the isolated Node DOM environment. This is NOT a browser/device UI test.
import { afterAll, expect, it, vi } from 'vitest';
import { fetch as networkFetch } from '../api/node_modules/undici/index.js';
import { api } from './src/lib/api.js';
import { DEF, useStore } from './src/store/useStore.js';
import { entryRoutineId, workoutVolume } from './src/lib/history.js';

const requests = [];
vi.stubGlobal('fetch', async (url, init = {}) => {
  const target = new URL(url, process.env.ACCEPTANCE_API);
  if (target.origin !== process.env.ACCEPTANCE_API) throw new Error('Non-test destination refused');
  const result = await networkFetch(target, { ...init, signal: undefined, headers: { ...init.headers, Cookie: process.env.ACCEPTANCE_COOKIE, Origin: 'http://localhost:4173' } });
  requests.push({ method: init.method || 'GET', endpoint: target.pathname, status: result.status });
  return result;
});
afterAll(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('official web store pulls Bridge data, edits a plan, deletes and undoes a workout over real HTTP', async () => {
  localStorage.clear();
  const { user } = await api('/api/me');
  useStore.setState({ S: structuredClone(DEF), user, ready: true });
  const before = await api('/api/data');
  await useStore.getState().pullState();
  const state = useStore.getState().S;
  expect(state.routines).toHaveLength(3);
  expect(state.workouts).toHaveLength(4);
  expect(requests.filter(r => r.method === 'PUT')).toHaveLength(0);
  expect(state.workouts.map(w => w.id).sort()).toEqual(before.state.workouts.map(w => w.id).sort());
  for (const label of ['A', 'B', 'C']) {
    const w = state.workouts.find(w => w.name === 'Synthetic workout ' + label);
    expect(entryRoutineId(w, w.entries[0])).toBe(before.state.routines.find(r => r.name.includes('Synthetic ' + label)).id);
    expect(workoutVolume(w)).toBe(label === 'A' ? 18 : 6);
  }
  useStore.getState().update(s => { s.routines[0].name = 'Synthetic A web sync'; }, false);
  await useStore.getState().pushState();
  expect((await api('/api/data')).state.routines[0].name).toBe('Synthetic A web sync');
  const w = structuredClone(useStore.getState().S.workouts.find(w => w.name === 'Synthetic workout A'));
  useStore.getState().update(s => { s.workouts = s.workouts.filter(x => x.id !== w.id); }, false);
  await useStore.getState().pushState();
  const deleted = (await api('/api/data')).state;
  expect(deleted.workouts.some(x => x.id === w.id)).toBe(false);
  expect(deleted.deleted.workouts[w.id]).toBeGreaterThan(0);
  useStore.getState().update(s => { s.workouts.push(w); }, false);
  await useStore.getState().pushState();
  const restored = (await api('/api/data')).state;
  expect(restored.workouts.filter(x => x.id === w.id)).toHaveLength(1);
  expect(restored.deleted.workouts[w.id]).toBeLessThan(0);
  expect(restored.routines[0].name).toBe('Synthetic A web sync');
  expect(restored.syntheticExtension).toEqual({ preserve: true });
}, 30000);
