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
      return { bytes, data: JSON.parse(bytes) };
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
    const proposal = this.proposal;
    if (!proposal || proposal.id !== proposal_id || proposal.expires <= this.writer.now()) throw new PlanError('Catalogue proposal expired', 'expired');
    this.proposal = null;
    const candidate = await this.fetchCandidate();
    if (digest(JSON.stringify(candidate)) !== proposal.nextHash) throw new PlanError('Candidate changed', 'conflict');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lock = this.file + '.refresh-lock';
    await fs.mkdir(lock, { mode: 0o700 });
    try {
      const current = await this.read();
      if ((current.bytes ? digest(current.bytes) : null) !== proposal.previousHash) throw new PlanError('Current catalogue changed', 'conflict');
      if (proposal.expires <= this.writer.now()) throw new PlanError('Catalogue proposal expired', 'expired');
      const backup = current.bytes ? path.basename(this.file) + '.' + randomUUID() + '.bak' : null;
      if (backup) {
        const handle = await fs.open(path.join(path.dirname(this.file), backup), 'wx', 0o600);
        try { await handle.writeFile(current.bytes); await handle.sync(); } finally { await handle.close(); }
      }
      await writeCredential(this.file, candidate);
      return { applied: true, backup, catalogue: metadata(candidate) };
    } finally { await fs.rmdir(lock); }
  }
}
