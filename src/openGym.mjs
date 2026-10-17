import fs from 'node:fs/promises';
import path from 'node:path';

export class GymHttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GymHttpError';
    this.status = status;
    this.body = body;
  }
}

// Atomic write, permission 0600; never print, log or expose a bearer token.
export async function writeCredential(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export class OpenGymClient {
  constructor({ baseUrl, tokenFile, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
  }

  async loadToken() {
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.tokenFile, 'utf8')); }
    catch { throw new Error('Bridge 尚未配对：请先通过官方网页生成一次性配对码，再运行 pair 命令'); }
    if (!raw || typeof raw.token !== 'string' || !raw.token.trim()) throw new Error('Bridge 配对文件无效');
    return raw.token;
  }

  async call(method, endpoint, body, authenticated = true) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${await this.loadToken()}`;
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + endpoint, {
        method, headers, signal: AbortSignal.timeout(15000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`连接 openGym 失败（${endpoint}）：${error.message}`);
    }
    let data;
    try { data = await response.json(); }
    catch { throw new GymHttpError(`openGym 返回了非 JSON 响应（${endpoint}）：HTTP ${response.status}`, response.status, null); }
    if (!response.ok) throw new GymHttpError(data?.error || `HTTP ${response.status}`, response.status, data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GymHttpError('openGym 返回的 JSON 格式无效', response.status, data);
    return data;
  }

  async pair(code) {
    if (!/^[A-HJ-NP-Z2-9]{8}$/i.test(code)) throw new Error('配对码应为 8 位英文字母和数字');
    const res = await this.call('POST', '/api/pair/redeem', { code: code.toUpperCase() }, false);
    if (!res.token || !res.user) throw new Error('openGym 未返回配对凭据');
    await writeCredential(this.tokenFile, { token: res.token, pairedAt: new Date().toISOString() });
    return { ok: true, name: res.user.name || '已登录用户' };
  }

  async refreshLogin() {
    const res = await this.call('GET', '/api/me');
    // The official Android client receives a fresh bearer token after half its lifetime.
    if (typeof res.token === 'string' && res.token.length) {
      await writeCredential(this.tokenFile, { token: res.token, refreshedAt: new Date().toISOString() });
    }
    return res;
  }

  async getData() {
    // Also verifies account status and refreshes long-lived pairing tokens if offered.
    await this.refreshLogin();
    const data = await this.call('GET', '/api/data');
    if (!Number.isInteger(data.rev) || data.rev < 0) throw new Error('openGym 没有返回有效的 rev');
    if (data.state !== null && (!data.state || typeof data.state !== 'object' || Array.isArray(data.state))) {
      throw new Error('openGym 没有返回有效的训练状态');
    }
    return data;
  }

  async putData({ state, baseRev, baseWid }) {
    if (!Number.isInteger(baseRev) || baseRev < 0) throw new Error('写入必须带 baseRev，禁止无条件覆盖');
    return this.call('PUT', '/api/data', {
      state, baseRev, ...(baseWid ? { baseWid } : {}),
      // Do NOT send `stamped:true`. The official server stamps API-side edits while
      // preserving unknown fields and client-side sync metadata.
    });
  }
}
