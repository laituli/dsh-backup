#!/usr/bin/env node
/**
 * probe-panel：对已启动的宿主做一次最小 RPC 探针（排查 "Service unavailable" 之类）。
 * 用法: node scripts/probe-panel.mjs <baseUrl> <token> <method> [jsonArgs]
 */
const [, , baseUrl, token, method = 'status', argsRaw = '{}'] = process.argv;
if (!baseUrl || !token) {
  console.error('用法: node scripts/probe-panel.mjs <baseUrl> <token> <method> [jsonArgs]');
  process.exit(2);
}
let cookie = '';
try {
  const res = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  console.log(`[probe] 鉴权 ${res.status} cookie=${Boolean(cookie)}`);
} catch (err) {
  console.error(`[probe] 鉴权失败: ${err.message}`);
  process.exit(1);
}
const rpcId = `probe-${Date.now()}`;
const started = Date.now();
// http-get / http-post：直接打插件自有 HTTP 路由（settings 等），不走 RPC 网关
if (method === 'http-get' || method === 'http-post') {
  const url = `${baseUrl}${argsRaw.startsWith('{') && argsRaw.includes('path') ? '' : ''}${process.env.PROBE_PATH || '/dsh-backup/settings'}`;
  const res2 = await fetch(url, {
    method: method === 'http-post' ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(method === 'http-post' ? { body: argsRaw } : {}),
    signal: AbortSignal.timeout(60000),
  });
  console.log(`[probe] ${method} ${url} HTTP ${res2.status}`);
  console.log((await res2.text()).slice(0, 900));
  process.exit(0);
}
const res = await fetch(`${baseUrl}/api/backupPanel/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify({ type: 'client-request', rpcId, method: `backupPanel/${method}`, payload: { args: JSON.parse(argsRaw) } }),
  signal: AbortSignal.timeout(180000),
});
const text = await res.text();
console.log(`[probe] ${method} HTTP ${res.status} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
let parsed = null;
try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
if (parsed && parsed.type === 'server-response') console.log(JSON.stringify(parsed.result?.value ?? parsed.result).slice(0, 800));
else console.log(String(text).slice(0, 800));
