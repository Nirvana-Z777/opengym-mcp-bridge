import path from 'node:path';

const env = (name, fallback) => process.env[name] || fallback;

export function configFromEnv() {
  const configuredBase = process.env.OPENGYM_BASE_URL;
  if (!configuredBase) throw new Error('必须设置 OPENGYM_BASE_URL，例如 http://NAS局域网IP:23323');
  const base = configuredBase.replace(/\/+$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('OPENGYM_BASE_URL 只能是 http(s)://主机[:端口]，不能包含密码、路径或查询参数');
  }
  const port = Number(env('MCP_PORT', '3003'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT 无效');
  return {
    baseUrl: base,
    tokenFile: path.resolve(env('OPENGYM_TOKEN_FILE', path.join(process.cwd(), 'secrets', 'opengym-token.json'))),
    catalogueFile: path.resolve(env('CATALOGUE_NAMES_FILE', path.join(process.cwd(), 'store', 'exercise-names.json'))),
    mcpSecretFile: path.resolve(env('MCP_SECRET_FILE', path.join(process.cwd(), 'secrets', 'mcp-access-token'))),
    transport: env('MCP_TRANSPORT', 'stdio'),
    host: env('MCP_HOST', '127.0.0.1'),
    port,
    writes: process.env.OPENGYM_ALLOW_WRITES === '1',
    proposalTtlMs: 10 * 60 * 1000,
  };
}
