#!/usr/bin/env node
/**
 * verify-upgrade-flow：在**隔离的真实宿主**里把「前端内升级」四步事务真跑一遍。
 *
 * 为什么必须是真宿主：清单要读 profile 的 git 源依赖、装配门要真起宿主、写入要走
 * pnpm，这些都只在宿主环境里成立；用桩测不出 `cannot get property ... without inject`
 * 这类只在 loader 里炸的问题（上一版就是这么把宿主打挂的）。
 *
 * 断言链：upgradePlan 读到 git 源与远端最新 tag → upgradeRun 走
 * 备份 → RESTART.txt → 装配门 → 写入 profile → 包版本真的变了 → RESTART.txt 内容可用。
 *
 * 用法: node scripts/verify-upgrade-flow.mjs [--port 13180] [--from v0.1.1] [--to v0.1.3]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SELF = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(argOf('--port', '13180'));
const FROM = argOf('--from', 'v0.1.1');
const TO = argOf('--to', 'v0.1.3');
const TARGET = 'dsh-personal-workflow';
const WF_REPO = argOf('--wf-repo', 'C:/Users/lai/Documents/GitHub/dsh/dsh-personal-workflow');
const BACKUP_REPO = argOf('--backup-repo', 'C:/Users/lai/dev/dsh-backup');
const BACKUP_TAG = argOf('--backup-tag', 'v0.11.11');
const DSH_BIN = argOf('--dsh-bin', 'C:/Users/lai/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js');

const results = [];
const ok = (name, good, detail = '') => { results.push({ name, good }); console.log(`  ${good ? '✅' : '❌'} ${name}${!good && detail ? ` — ${detail}` : ''}`); };

function extract(repo, tag, destRoot) {
  const out = path.join(destRoot, `${path.basename(repo)}-${tag}`);
  fs.mkdirSync(out, { recursive: true });
  const tarPath = path.join(destRoot, `${path.basename(repo)}-${tag}.tar`);
  const a = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tarPath, tag], { encoding: 'utf8' });
  if (a.status !== 0) throw new Error(`git archive ${repo}@${tag} 失败: ${a.stderr}`);
  const x = spawnSync('tar', ['-xf', tarPath, '-C', out], { encoding: 'utf8' });
  if (x.status !== 0) throw new Error(`解包 ${tag} 失败: ${x.stderr}`);
  return out;
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vupg-'));
const backupPkg = extract(BACKUP_REPO, BACKUP_TAG, stage);
const wfOld = extract(WF_REPO, FROM, stage);
// 依赖 peers：解出来的 dsh-backup 目录不在 pnpm 布局里，借用商店已解析好的 peer 目录
const storePeers = (() => {
  try { return path.join(fs.realpathSync(path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@xiaoyuyu6420', 'dsh-backup')), '..', '..'); } catch { return null; }
})();
if (storePeers && fs.existsSync(path.join(storePeers, '@deepseek-ai'))) {
  fs.symlinkSync(storePeers, path.join(backupPkg, 'node_modules'), 'junction');
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vupg-home-'));
const webDir = path.join(home, 'profiles', 'web');
const nm = path.join(webDir, 'node_modules');
fs.mkdirSync(path.join(nm, '@xiaoyuyu6420'), { recursive: true });
fs.symlinkSync(backupPkg, path.join(nm, '@xiaoyuyu6420', 'dsh-backup'), 'junction');
fs.symlinkSync(wfOld, path.join(nm, TARGET), 'junction');
// 关键：装的是**真实 git spec**（旧 tag），这样 upgradePlan 才认得出并查到远端最新 tag
fs.writeFileSync(path.join(webDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {
    '@xiaoyuyu6420/dsh-backup': `github:laituli/dsh-backup#${BACKUP_TAG}`,
    [TARGET]: `github:laituli/${TARGET}#${FROM}`,
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xiaoyuyu6420/dsh-backup', TARGET], patchReload: 'live' } },
}, null, 2)}\n`);
fs.writeFileSync(path.join(webDir, 'cordis.yml'), '[]\n');
fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), ['# verify-upgrade-flow', '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${PORT}`, ''].join('\n'));

const base = `http://127.0.0.1:${PORT}`;
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vupg-dest-'));
const logPath = path.join(home, 'boot.log');
const logFd = fs.openSync(logPath, 'w');
console.log(`[vupg] home=${home} port=${PORT} 目标=${TARGET} ${FROM} → ${TO}`);
const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open', '--port', String(PORT)], {
  env: { ...process.env, DSH_HOME: home, DSH_WEB_URL: base }, stdio: ['ignore', logFd, logFd], windowsHide: true,
});
let exited = null;
child.on('exit', (c) => { exited = c; });
let token = '';
const t0 = Date.now();
while (Date.now() - t0 < 90_000 && exited === null && !token) {
  const m = /dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(logPath, 'utf8'));
  if (m) token = m[1]; else await new Promise((r) => setTimeout(r, 500));
}
ok('隔离宿主启动成功', exited === null && Boolean(token), exited !== null ? `exit=${exited}` : '90s 未就绪');
if (!token) { try { child.kill(); } catch { /* */ } process.exit(1); }

let cookie = '';
try {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
} catch { /* 忽略 */ }
const rpc = async (method, args = {}, timeoutMs = 600_000) => {
  try {
    const r = await fetch(`${base}/api/backupPanel/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId: `vupg-${Date.now()}`, method: `backupPanel/${method}`, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = JSON.parse(await r.text());
    return j?.type === 'server-response' ? (j.result?.value ?? j.result) : { ok: false, raw: String(j).slice(0, 200) };
  } catch (e) { return { ok: false, raw: e.message }; }
};
const http = async (url, opts = {}) => {
  const r = await fetch(`${base}${url}`, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  return { status: r.status, text: await r.text() };
};

// 目的地切到隔离目录（否则备份会打到真实备份根）
const set0 = await http('/dsh-backup/settings');
const set1 = await http('/dsh-backup/settings', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ revision: JSON.parse(set0.text).revision, destination: dest }),
});
ok('目的地=隔离目录（不污染真实备份根）', set1.status === 200 && set1.text.includes(path.basename(dest)), `HTTP ${set1.status}`);

const plan = await rpc('upgradePlan', {}, 120_000);
const entry = (plan?.plugins ?? []).find((p) => p.name === TARGET);
ok('upgradePlan 认出 git 源依赖', Boolean(entry) && entry.spec.includes('github:'), JSON.stringify(plan).slice(0, 200));
ok(`upgradePlan 读到当前 tag=${FROM}`, entry?.current === FROM, String(entry?.current));
ok(`upgradePlan 查到远端最新 tag=${TO} 且标记 hasUpdate`, entry?.latest === TO && entry?.hasUpdate === true, JSON.stringify(entry ?? {}).slice(0, 360));

const run = await rpc('upgradeRun', { kind: 'one', name: TARGET }, 900_000);
const item = (run?.plugins ?? [])[0] ?? {};
ok('upgradeRun 事务返回成功（装配门+写入都过）', run?.ok === true && item.ok === true, JSON.stringify(run).slice(0, 400));
ok('① 升级前备份已生成', typeof run?.backupName === 'string' && run.backupName.length > 0, String(run?.backupName));
const restartFile = String(run?.restartFile ?? '');
ok('② RESTART.txt 已落盘', restartFile.endsWith('RESTART.txt') && fs.existsSync(restartFile), restartFile);
if (fs.existsSync(restartFile)) {
  const txt = fs.readFileSync(restartFile, 'utf8');
  ok('② RESTART.txt 含成对指令（端口结束进程 + dsh web）',
    txt.includes('Stop-Process') && /(^|\n)dsh web(\n|$)/.test(txt) && txt.includes('http'), txt.slice(0, 160));
}
const pkg = JSON.parse(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'));
const newSpec = String(pkg.dependencies?.[TARGET] ?? '');
ok('④ 真实 profile 的 spec 已写入新 tag（重启后生效）', newSpec.includes(`#${TO}`), newSpec);
ok('③ 未降级：spec 里没有更低的 tag', !newSpec.includes(`#${FROM}`), newSpec);

try { child.kill(); } catch { /* 已退出 */ }
await new Promise((r) => setTimeout(r, 800));
try { fs.closeSync(logFd); } catch { /* 忽略 */ }
const failed = results.filter((r) => !r.good).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过（home=${home}）`);
process.exitCode = failed ? 1 : 0;
