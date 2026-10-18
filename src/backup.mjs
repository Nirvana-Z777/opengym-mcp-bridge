import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { PlanError } from './errors.mjs';
import { integer, isObject } from './validate.mjs';

const OWN_FILE = /^opengym-backup-\d{8}T\d{9}Z-[0-9a-f-]{36}\.json$/;
const PRIVATE_KEYS = /(?:authorization|cookie|password|secret|api[_-]?key|token|bearer)$/i;
function rejectCredentials(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key)) throw new PlanError('State contains credential-like fields; backup and write refused', 'backup-failed');
    rejectCredentials(child);
  }
}

export class FileBackupStore {
  constructor({ directory, keep = 20, now = Date.now, io = fs }) {
    if (typeof directory !== 'string' || !directory) throw new PlanError('Backup directory must be configured', 'backup-failed');
    this.directory = path.resolve(directory);
    this.keep = integer(keep, 1, 100, 'backup retention');
    this.now = now;
    this.io = io;
  }

  async create(snapshot, operation) {
    let temporary;
    try {
      if (!isObject(snapshot.state) || !Number.isInteger(snapshot.rev) || snapshot.rev < 0) throw new Error('invalid snapshot');
      if (!/^[a-z][a-z0-9_-]{0,60}$/.test(operation)) throw new Error('invalid operation');
      rejectCredentials(snapshot.state);
      const created = new Date(this.now()).toISOString();
      const stamp = created.replace(/[-:.]/g, '');
      const name = `opengym-backup-${stamp}-${randomUUID()}.json`;
      await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await this.io.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory');
      await this.io.chmod(this.directory, 0o700);
      temporary = path.join(this.directory, '.' + name + '.tmp');
      const destination = path.join(this.directory, name);
      const payload = { format: 'opengym-mcp-bridge-backup', version: 1, created_at: created, operation,
        revision: snapshot.rev, write_id: snapshot.state._wid ?? null, state: snapshot.state };
      const handle = await this.io.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      try {
        await handle.writeFile(JSON.stringify(payload) + '\n', 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await this.io.chmod(temporary, 0o600);
      await this.io.rename(temporary, destination);
      temporary = null;
      const files = [];
      for (const entry of await this.io.readdir(this.directory, { withFileTypes: true })) {
        if (entry.isFile() && !entry.isSymbolicLink() && OWN_FILE.test(entry.name)) files.push(entry.name);
      }
      files.sort();
      const previous = files.filter(file => file !== name);
      for (const old of previous.slice(0, Math.max(0, previous.length - this.keep + 1))) await this.io.unlink(path.join(this.directory, old));
      return { id: name, created_at: created, source_revision: snapshot.rev, retained_limit: this.keep };
    } catch {
      throw new PlanError('本地备份失败，未提交任何写入；请检查专用备份目录及权限', 'backup-failed');
    } finally {
      if (temporary) await this.io.unlink(temporary).catch(() => {});
    }
  }
}
