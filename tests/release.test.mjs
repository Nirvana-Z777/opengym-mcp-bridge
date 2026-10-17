import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { dispatch } from '../src/mcp.mjs';

// Only synthetic configuration is used; these tests never contact an openGym account.
const packageUrl = new URL('../package.json', import.meta.url);
const packageInfo = JSON.parse(await readFile(packageUrl, 'utf8'));
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' };

test('MCP initialization reports the package version', async () => {
  const reply = await dispatch(initialize, { writes: false });
  assert.equal(reply.result.serverInfo.version, packageInfo.version);
});

test('The stdio entry point works from a path with spaces and Unicode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge CLI 测试 '));
  try {
    await cp(new URL('../src/', import.meta.url), path.join(dir, 'src'), { recursive: true });
    await cp(packageUrl, path.join(dir, 'package.json'));
    const result = spawnSync(process.execPath, [path.join(dir, 'src', 'mcp.mjs')], {
      cwd: dir,
      env: { OPENGYM_BASE_URL: 'https://test.invalid', MCP_TRANSPORT: 'stdio', OPENGYM_ALLOW_WRITES: '0' },
      input: JSON.stringify(initialize) + '\n',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), 'The CLI must reply to the initialization request');
    const reply = JSON.parse(result.stdout.trim());
    assert.equal(reply.result.serverInfo.version, packageInfo.version);
    assert.equal(reply.id, initialize.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
