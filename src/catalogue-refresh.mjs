import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CATALOGUE_SOURCE, fetchCatalogue } from './catalogue.mjs';
import { writeCredential } from './openGym.mjs';
import { PlanError } from './errors.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = data => ({
  source: data?.source ?? null, version: data?.source_version ?? null, commit: data?.source_commit ?? null,
  count: Object.keys(data?.names ?? {}).length, translated: data?.translated ?? null,
});

export class CatalogueRefresh {
  constructor(file, writer, fetchCandidate = fetchCatalogue) {
    this.file = file;
    this.writer = writer;
    this.fetchCandidate = fetchCandidate;
    this.proposal = null;
  }

  async read() {
    if (!this.file) throw new PlanError('Local catalogue path is missing');
    try {
      const bytes = await fs.readFile(this.file);
      const data = JSON.parse(bytes);
      if (!data?.names || typeof data.names !== 'object' || Array.isArray(data.names))
        throw new Error('Not an exercise catalogue');
      return { bytes, data };
    } catch (error) {
      if (error.code === 'ENOENT') return { bytes: null, data: null };
      throw new PlanError('Existing catalogue cannot be read safely', 'catalogue-invalid');
    }
  }

  async status() {
    const { data } = await this.read();
    return { current: metadata(data), available: CATALOGUE_SOURCE,
      update_available: data?.source_commit !== CATALOGUE_SOURCE.commit };
  }

  async preview() {
    const current = await this.read();
    const candidate = await this.fetchCandidate();
    const nextHash = digest(JSON.stringify(candidate));
    const previousHash = current.bytes ? digest(current.bytes) : null;
    const diff = { added: [], removed: [], renamed: [], muscle_mapping_changed: [] };
    const old = current.data?.names ?? {};
    for (const [id, name] of Object.entries(candidate.names)) {
      if (!Object.hasOwn(old, id)) diff.added.push(id);
      else {
        const previous = current.data.exercises?.[id];
        const next = candidate.exercises[id];
        if (old[id] !== name || previous?.n !== next.n) diff.renamed.push(id);
        const muscles = item => ['bp','tg','sm','primaries','secondaries','muscleGroups','muscleWeights'].map(key => item?.[key]);
        if (!isDeepStrictEqual(muscles(previous), muscles(next))) diff.muscle_mapping_changed.push(id);
      }
    }
    for (const id of Object.keys(old)) if (!Object.hasOwn(candidate.names, id)) diff.removed.push(id);
    const changed = !isDeepStrictEqual(current.data, candidate);
    const id = changed ? randomUUID() : null;
    const expires = this.writer.now() + this.writer.ttl;
    this.proposal = changed ? { id, expires, previousHash, nextHash } : null;
    return { current: metadata(current.data), candidate: metadata(candidate), source_digests: candidate.source_digests,
      candidate_digest: nextHash, changed, proposal_id: id, expires_at: changed ? new Date(expires).toISOString() : null,
      changes: Object.fromEntries(Object.entries(diff).map(([key, ids]) => [key, { count: ids.length, sample_ids: ids.slice(0, 20) }])) };
  }

  async apply({ proposal_id, confirmation }) {
    if (!this.writer.writes || confirmation !== '我确认写入') throw new PlanError('Catalogue refresh requires enabled writes and explicit confirmation');
    return this.writer.refreshCatalogue(async () => {
      const proposal = this.proposal;
      if (!proposal || proposal.id !== proposal_id || proposal.expires <= this.writer.now())
        throw new PlanError('Catalogue proposal expired', 'expired');

      const directory = path.dirname(this.file);
      const lock = this.file + '.refresh-lock';
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.mkdir(lock, { mode: 0o700 });
      } catch (error) {
        if (error.code === 'EEXIST') throw new PlanError('Catalogue refresh lock is occupied', 'busy');
        throw new PlanError('Could not acquire the catalogue refresh lock', 'catalogue-lock-failed');
      }

      let result;
      try {
        this.proposal = null;
        const candidate = await this.fetchCandidate();
        if (digest(JSON.stringify(candidate)) !== proposal.nextHash)
          throw new PlanError('Candidate changed', 'conflict');
        const readUnchanged = async () => {
          const current = await this.read();
          if ((current.bytes ? digest(current.bytes) : null) !== proposal.previousHash)
            throw new PlanError('Current catalogue changed', 'conflict');
          if (proposal.expires <= this.writer.now())
            throw new PlanError('Catalogue proposal expired', 'expired');
          return current;
        };
        const current = await readUnchanged();
        const backup = current.bytes ? path.basename(this.file) + '.' + randomUUID() + '.bak' : null;
        if (backup) await this.backup(path.join(directory, backup), current.bytes);
        try {
          await writeCredential(this.file, candidate, { beforeReplace: readUnchanged });
        } catch (error) {
          if (error instanceof PlanError) throw error;
          throw new PlanError('Atomic catalogue replacement failed; previous file kept', 'catalogue-replace-failed');
        }
        result = { applied: true, backup, catalogue: metadata(candidate) };
      } finally {
        try { await fs.rmdir(lock); }
        catch {
          // Once renamed, report success and invalidate old previews even if cleanup fails.
          if (result) result.warning = 'Catalogue replaced, but the refresh lock could not be removed.';
        }
      }
      return result;
    });
  }

  async backup(file, bytes) {
    let created = false;
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      created = true;
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
    } catch {
      if (created) await fs.rm(file, { force: true }).catch(() => {});
      throw new PlanError('Catalogue backup failed; previous file kept', 'backup-failed');
    }
  }
}
