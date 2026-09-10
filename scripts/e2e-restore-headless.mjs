#!/usr/bin/env node
/**
 * e2e-restore-headless：无 LLM 的“人工交接恢复”验证。
 *
 * 前提：PATH 有 dsh CLI（本机 npm global shim 即可）；仓库内 rescue/lib 已构建。
 * 做法（全部隔离在临时 DSH_HOME，不碰真实数据）：
 *   1. 临时 home + profiles/web（node_modules 以 junction 指向真实 web profile 的
 *      store，webserver 端口 patch 到 E2E_PORT，避免撞上正在跑的 3080）；
 *   2. boot 真宿主（node <dsh>/lib/bin.js web，DSH_HOME=临时 home），等 HTTP 就绪；
 *   3. RPC backup（先种下健康会话文件），产生归档；
 *   4. rescue stop 停掉宿主（验证 stop 子命令幂等可用）；
 *   5. 破坏 tempHome 下的 sessions/settings（模拟 agent 起不来）；
 *   6. 原样执行面板会给出的 offlineCmd：node <repo>/rescue/rescue.mjs restore <归档> --yes --root <dest>
 *      （DSH_HOME=临时 home，验证“任何 shell 可粘贴的完整指令”）；
 *   7. 再 boot 宿主（同一 relaunch 命令形态）→ HTTP 就绪 → RPC status/backup 恢复，
 *      断言会话与配置齐全；停宿主清理。
 * 零依赖；退出码 0=全过，1=有失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// 定位全局安装的 dsh CLI（node <bin.js> web）：npm global prefix 候选
function resolveDshBin() {
  const candidates = [
    process.env.npm_prefix ? path.join(process.env.npm_prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : '',
    process.env.HOME ? path.join(process.env.HOME, '.local', 'share', 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : '',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  // 兜底：PATH 里 dsh shim 指向的真实 bin
  const shim = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' });
  if (shim.status === 0) {
    const first = String(shim.stdout).split(/\r?\n/).find((l) => l.trim());
    if (first) {
      const real = path.join(path.dirname(first), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(real)) return real;
    }
  }
  return null;
}
const DSH_BIN = resolveDshBin();
const realProfile = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'web') : null;
const E2E_PORT = Number(process.env.E2E_RESTORE_PORT || 13140);
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const BOOT_TIMEOUT_MS = 120_000;

let home = null;
let hostProc = null;
let bootLogPath = null;
let bootLogFd = null;
let authCookie = '';
let bootToken = '';
const CK = () => (authCookie ? { Cookie: authCookie } : {});
/** 带超时的 fetch（默认 20s）：认证流程/后台挂起时不至于无限等待。 */
function req(url, opts = {}) {
  const { timeoutMs = 20000, ...rest } = opts;
  return fetch(url, { ...rest, headers: { ...(rest.headers || {}), ...CK() }, signal: AbortSignal.timeout(timeoutMs) });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  return ok;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, env: { ...process.env, ...(opts.env || {}) }, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return r.stdout;
}
function runQuiet(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...(opts.env || {}) }, ...opts });
  return { ok: r.error == null && r.status === 0, out: r.stdout || '', err: r.stderr || '', status: r.status };
}

function dumpBootLog(tag) {
  try {
    const lines = fs.readFileSync(bootLogPath, 'utf8').split('\n').filter((l) => l).slice(-25);
    console.error(`[e2e-restore][${tag}] boot.log tail:\n${lines.join('\n')}`);
  } catch { /* 无日志 */ }
}

function startBoot() {
  bootLogPath = path.join(home, 'boot.log');
  if (bootLogFd != null) { try { fs.closeSync(bootLogFd); } catch { /* 忽略 */ } }
  bootLogFd = fs.openSync(bootLogPath, 'a');
  const env = { ...process.env, DSH_HOME: home, DSH_WEB_URL: BASE };
  // --no-open：headless 验证不弹浏览器
  hostProc = spawn(process.execPath, [DSH_BIN, 'web', '--no-open'], { env, stdio: ['ignore', bootLogFd, bootLogFd], windowsHide: true });
  hostProc.once('error', (e) => console.error(`[e2e-restore] host spawn error: ${e.message}`));
}

function closeBootLog() {
  if (bootLogFd != null) { try { fs.closeSync(bootLogFd); } catch { /* 忽略 */ } bootLogFd = null; }
}

function stopBoot() {
  return new Promise((resolve) => {
    closeBootLog();
    if (!hostProc) return resolve();
    const p = hostProc;
    hostProc = null;
    p.once('exit', () => resolve());
    try { p.kill(); } catch { /* 已退出 */ }
    setTimeout(resolve, 4000);
  });
}

/** 等到端口不再监听（Windows 上句柄未释放会让 restore 的 rename 报 EPERM）。 */
async function waitPortFree(maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetch(BASE, { signal: AbortSignal.timeout(1200) });
    } catch {
      return true; // 连接失败 = 端口已释放
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 等待宿主就绪：0.1.2-rc+ 的 web 需要 `GET /?token=...` 换 HttpOnly cookie
 * （token 打印在 boot 日志里），之后的页面与 API 全部凭 cookie。
 */
async function waitBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  bootToken = '';
  while (Date.now() < deadline && !bootToken) {
    try {
      const log = fs.readFileSync(bootLogPath, 'utf8');
      const m = /dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(log);
      if (m) bootToken = m[1];
    } catch { /* 日志未就绪 */ }
    if (!bootToken) await new Promise((r) => setTimeout(r, 500));
  }
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/?token=${encodeURIComponent(bootToken)}`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length) authCookie = cookies.map((c) => c.split(';')[0]).join('; ');
      const page = await req(BASE, { signal: AbortSignal.timeout(3000) });
      if (page.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  dumpBootLog('等待超时');
  throw new Error(`boot 超时（${BOOT_TIMEOUT_MS / 1000}s 内未在 ${BASE} 就绪）`);
}

async function rpc(method, args = {}, timeoutMs = 20000) {
  // 改 settings（destination 属于插件配置）会触发宿主的 live patch 重载：重载窗口内
  // RPC 网关会短暂报 gateway/service-unavailable。这是宿主的既定行为，不是被测缺陷，
  // 故对这一个错误码做有限重试（两次，间隔 600ms）；其余错误照旧原样返回。
  for (let round = 0; ; round += 1) {
    const out = await rpcOnce(method, args, timeoutMs);
    const raw = String(out?.raw ?? out?.error?.message ?? '');
    if (!(out?.ok === false && /service-unavailable|is unavailable/i.test(raw)) || round >= 2) return out;
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function rpcOnce(method, args = {}, timeoutMs = 20000) {
  try {
    const res = await req(`${BASE}/api/backupPanel/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `backupPanel/${method}`, payload: { args } }),
      timeoutMs,
    });
    const json = JSON.parse(await res.text());
    if (json?.type !== 'server-response') return { ok: false, raw: String(json).slice(0, 200) };
    return json.result?.value ?? json.result;
  } catch (err) {
    return { ok: false, raw: err.message };
  }
}

async function main() {
  // ---------- 前置 ----------
  if (!fs.existsSync(DSH_BIN)) throw new Error(`DSH CLI 未找到: ${DSH_BIN}（请先安装 @deepseek-ai/dsh）`);
  const profileSrc = realProfile && fs.existsSync(realProfile)
    ? realProfile
    : (() => { const p = path.join(os.homedir(), '.dsh', 'profiles', 'web'); if (!fs.existsSync(p)) throw new Error('找不到真实 web profile 做 node_modules junction 来源'); return p; })();

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rh-'));
  console.log(`[e2e-restore] home=${home} port=${E2E_PORT}`);

  // 临时 profile：元数据文件复制 + node_modules 逐项 junction 镜像到真实 store
  const webDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(webDir, { recursive: true });
  for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    const src = path.join(profileSrc, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(webDir, f));
  }
  // 临时 profile 的 node_modules：按真实 store 逐项 junction 镜像（而不是整目录
  // junction），这样唯一的例外——本仓工作树——可以覆盖已安装副本。
  // 意义：E2E 验证的是「当前工作树」，而不是商店里上一次装好的版本。
  const realNm = path.join(profileSrc, 'node_modules');
  const nmDir = path.join(webDir, 'node_modules');
  fs.mkdirSync(nmDir, { recursive: true });
  // 本仓宿主代码来自哪里：dev（默认，工作树）| store（商店里已安装的那份）。
  // store 用于把「宿主代码差异」与「依赖/客户端半边的解析差异」分开定位。
  const pluginSrc = process.env.E2E_PLUGIN_SRC || 'dev';
  const storePkgDir = fs.realpathSync(path.join(realNm, '@xiaoyuyu6420', 'dsh-backup'));
  // dev 模式不能直接 junction 工作树：开发仓的 node_modules 里可能有 smoke 用的桩
  // （@deepseek-ai/dsh-tools@0.0.0-smoke-stub 等），直连时插件在真宿主里注册不上
  // （表现为端点报 active Service "backupPanel" is unavailable）。故：把工作树的
  // 发布文件复制进临时包，node_modules 指向商店那支配好的 peer 目录。
  let devStage = null;
  if (pluginSrc === 'dev') {
    devStage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devpkg-'));
    for (const f of ['package.json', 'cordis.patch.yml']) {
      fs.copyFileSync(path.join(repoRoot, f), path.join(devStage, f));
    }
    fs.mkdirSync(path.join(devStage, 'lib'), { recursive: true });
    for (const f of ['index.js', 'client.js']) {
      fs.copyFileSync(path.join(repoRoot, 'lib', f), path.join(devStage, 'lib', f));
    }
    fs.symlinkSync(path.join(storePkgDir, '..', '..'), path.join(devStage, 'node_modules'), 'junction');
  }
  const DEV_LINK = { '@xiaoyuyu6420/dsh-backup': devStage ?? storePkgDir };
  console.log(`[e2e-restore] 宿主代码来源=${pluginSrc}（${DEV_LINK['@xiaoyuyu6420/dsh-backup']}）`);
  const linkEntry = (from, toName) => {
    try { fs.symlinkSync(from, path.join(nmDir, toName), 'junction'); return; } catch { /* 回退 */ }
    try { fs.cpSync(from, path.join(nmDir, toName), { recursive: true }); } catch { /* 忽略 */ }
  };
  for (const entry of fs.readdirSync(realNm)) {
    if (entry.startsWith('@')) {
      const scopeReal = path.join(realNm, entry);
      if (!fs.statSync(scopeReal).isDirectory()) { linkEntry(scopeReal, entry); continue; }
      fs.mkdirSync(path.join(nmDir, entry), { recursive: true });
      for (const pkg of fs.readdirSync(scopeReal)) {
        const dev = DEV_LINK[`${entry}/${pkg}`];
        fs.symlinkSync(dev || path.join(scopeReal, pkg), path.join(nmDir, entry, pkg), 'junction');
      }
      continue;
    }
    if (DEV_LINK[entry]) { fs.symlinkSync(DEV_LINK[entry], path.join(nmDir, entry), 'junction'); continue; }
    linkEntry(path.join(realNm, entry), entry);
  }
  console.log(`[e2e-restore] node_modules 镜像完成`);
  // webserver 端口 patch：隔离端口，避免与真实 3080 冲突
  fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), [
    '# e2e restore isolated profile',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${E2E_PORT}`,
    '',
  ].join('\n'));

  // ---------- 1) 种健康数据 + boot ----------
  const sessRoot = path.join(home, 'sessions', '_no-cwd', 'sess-rh');
  const headerLine = JSON.stringify({ type: 'session', version: 0, id: 'sess-rh', createdAt: 1724544000000, delegationDepth: 0 });
  const healthy = Buffer.concat([
    zstdCompressSync(`${headerLine}\n`),
    zstdCompressSync(`${JSON.stringify({ type: 'user/message', seq: 0 })}\n`),
  ]);
  fs.mkdirSync(sessRoot, { recursive: true });
  fs.writeFileSync(path.join(sessRoot, 'session.jsonl.zstd'), healthy);
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n');
  fs.writeFileSync(path.join(home, 'marker-ok.txt'), 'restore-me');

  console.log('[e2e-restore] boot（第一次）…');
  startBoot();
  await waitBoot();

  // RPC 备份 → 归档
  const settings = await req(`${BASE}/dsh-backup/settings`).then((r) => r.json()).catch(() => null);
  // 备份目的地必须在数据目录之外：否则整包恢复挪走数据目录时归档自身随之失效
  // （正是本脚本早前踩到的真实隐患，现在插件与 rescue 都已加护栏）。
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rh-dest-'));
  const destTag = path.basename(dest);
  // 关键：这一步必须成功。曾出现 POST 静默失败（未检查状态码）→ 目的地仍是真实
  // ~/Desktop/dsh-backups → 该目录 auto.json 带真实 githubRepo/token → 备份链路去做
  // 真实网络 push（刚性重试 30 分钟）→ backup RPC 180s 超时。现在硬断言状态码。
  let destOk = false;
  let postJson = null;
  if (settings && settings.revision !== undefined) {
    const postRes = await req(`${BASE}/dsh-backup/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: settings.revision, destination: dest }),
    });
    const postText = await postRes.text().catch(() => '');
    try { postJson = JSON.parse(postText); } catch { postJson = null; }
    destOk = postRes.status === 200 && postText.includes(destTag);
    check('设置目的地=隔离 bkdest（POST 200 且回显）', destOk, `HTTP ${postRes.status} ${postText.slice(0, 240)}`);
  } else {
    check('设置目的地=隔离 bkdest（POST 200 且回显）', false, `GET settings 异常: ${JSON.stringify(settings).slice(0, 200)}`);
  }
  // 双保险：隔离宿主绝不能继承真实 GitHub 配置（否则会把临时 home 推到用户真实仓库）。
  // 注意要点名查 githubStatus().repo —— 那是「运行时 auto.json」层，历史上正是它
  // 在目的地切换后仍留着真实仓库，settings 层的 githubRepo 却是空字符串。
  let gh0 = await rpc('githubStatus');
  if (gh0?.repo != null) {
    // 旧版本/异常路径会把上一个根的仓库状态带到新根：先在隔离宿主里显式清掉再继续
    // （清不掉就中止，绝不冒险把临时数据推向用户真实仓库）
    await rpc('setGithubRepo', { repo: '' }, 30000);
    gh0 = await rpc('githubStatus');
  }
  const repoLeak = gh0?.repo != null;
  check('隔离宿主未继承真实 GitHub 配置（githubStatus.repo 为空）', gh0?.repo == null, JSON.stringify(gh0).slice(0, 240));
  if (!destOk || repoLeak) {
    // 目的地没切过去 → 后续备份会打到真实备份根（含真实 GitHub 配置），既慢又污染真实数据
    console.log('[e2e-restore] 目的地未切换成功，中止后续步骤（避免污染真实备份根）');
    return;
  }
  if (process.env.E2E_STOP_AFTER === 'settings') {
    const eff = await req(`${BASE}/dsh-backup/settings`).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
    console.log(`[e2e-restore] 诊断停机（E2E_STOP_AFTER=settings）:\n${String(eff).slice(0, 900)}`);
    return;
  }
  const bk = await rpc('backup', {}, 180000);
  check('RPC backup 成功并落到隔离 bkdest', bk?.ok === true && String(bk?.path ?? '').includes(destTag), JSON.stringify(bk).slice(0, 200));
  const archive = path.basename(String(bk?.path ?? '')).replace(/\.tar\.gz$/, '');
  const archives = fs.readdirSync(dest).filter((f) => /^dsh-\d.*\.tar\.gz$/.test(f));
  check('bkdest 出现归档', archives.length >= 1, archives.join(', '));

  // 拿到面板会给出的交接指令字段（stop/relaunch/offline）
  const pre = await rpc('restore', { selector: archive, dryRun: true });
  check('dry-run 预览可用', pre?.ok === true && pre?.dryRun === true, JSON.stringify(pre).slice(0, 160));

  // ---------- 2) rescue stop 停宿主（验证 stop 子命令）----------
  const rescuePath = path.join(repoRoot, 'rescue', 'rescue.mjs');
  // fork 增量的运维入口（stop / 停机窗口恢复编排）；恢复本身仍由上游 rescue.mjs 执行
  const opsPath = path.join(repoRoot, 'rescue', 'ops.mjs');
  const stopEnv = { ...process.env, DSH_HOME: home };
  const stopR = runQuiet(process.execPath, [opsPath, 'stop', '--web-port', String(E2E_PORT)], { env: stopEnv });
  check('rescue stop 结束宿主进程', stopR.ok === true, `${stopR.status}: ${stopR.out || stopR.err}`.slice(0, 200));
  if (hostProc) { try { hostProc.kill(); } catch { /* 已被 stop 结束 */ } hostProc = null; }
  // 关掉本进程持有的 boot.log 句柄并等端口释放——Windows 上任一句柄都会让
  // restore 的整目录 rename 报 EPERM（实测坑）
  closeBootLog();
  const freed = await waitPortFree(30000);
  check('旧宿主已停止且端口释放（供恢复/重启）', freed, `port ${E2E_PORT} 仍被占用`);

  // ---------- 3) 破坏现场 ----------
  fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'settings.yaml'), { force: true });
  fs.rmSync(path.join(home, 'marker-ok.txt'), { force: true });
  fs.writeFileSync(path.join(home, 'broken.txt'), 'host broke after restart');
  check('现场已破坏（sessions/settings/marker 均不在）', !fs.existsSync(path.join(home, 'settings.yaml')) && !fs.existsSync(path.join(home, 'marker-ok.txt')) && !fs.existsSync(path.join(home, 'sessions')));

  // ---------- 4) 原样执行“面板交接指令”中的 offline 恢复 ----------
  const offline = ['node', JSON.stringify(opsPath), 'deploy-restore', archive, '--yes', '--root', JSON.stringify(dest), '--delay', '0', '--web-port', String(E2E_PORT)].join(' ');
  console.log(`[e2e-restore] 执行交接指令: ${offline}`);
  const env = { ...process.env, DSH_HOME: home };
  const rr = runQuiet(process.execPath, [opsPath, 'deploy-restore', archive, '--yes', '--root', dest, '--delay', '0', '--web-port', String(E2E_PORT)], { env });
  check('ops.mjs deploy-restore --yes 恢复成功', rr.ok === true && /✅|恢复完成/.test(rr.out), `${rr.status}: ${(rr.out || rr.err).slice(0, 300)}`);

  const sessBack = fs.existsSync(path.join(home, 'sessions', '_no-cwd', 'sess-rh', 'session.jsonl.zstd'));
  const settingsBack = fs.existsSync(path.join(home, 'settings.yaml'));
  const markerBack = fs.existsSync(path.join(home, 'marker-ok.txt'));
  check('恢复后：会话文件回到原位', sessBack);
  check('恢复后：settings.yaml 回到原位', settingsBack);
  check('恢复后：marker 回到原位', markerBack);

  // 整包恢复替换整个数据目录，profiles 下的 node_modules 不随归档（真实用户按
  // 恢复提示重装依赖）——本测试用 junction 模拟这一步“pnpm install”，否则第二次
  // boot 无法解析 profile bundle。
  const webDirAfter = path.join(home, 'profiles', 'web');
  fs.mkdirSync(webDirAfter, { recursive: true });
  fs.rmSync(path.join(webDirAfter, 'node_modules'), { recursive: true, force: true });
  fs.symlinkSync(path.join(profileSrc, 'node_modules'), path.join(webDirAfter, 'node_modules'), 'junction');
  check('恢复后重接 profile 依赖（等价 pnpm install）', fs.existsSync(path.join(webDirAfter, 'package.json')));

  // ---------- 5) relaunch：同一命令形态再 boot → agent 宿主可用 ----------
  console.log('[e2e-restore] boot（恢复后，第二次）…');
  startBoot();
  await waitBoot();
  const st = await rpc('status');
  // status 返回体本身没有 ok 字段（纯快照数据）：按 backups/destination 断言
  check('恢复后宿主 RPC status 可用且能列出归档', Array.isArray(st?.backups) && st.backups.length >= 1 && String(st?.destination ?? '') === dest.split('\\').join('/'), JSON.stringify(st).slice(0, 200));
  // 「重启 / 升级」卡片的数据源：面板靠 status.restart 渲染成对指令
  check('status 返回「重启/升级」成对指令（stop + relaunch + 端口）',
    typeof st?.restart?.stopCmd === 'string' && st.restart.stopCmd.includes('stop') && st.restart.stopCmd.includes('ops.mjs')
    && typeof st?.restart?.relaunchCmd === 'string' && /node/i.test(st.restart.relaunchCmd)
    && Number.isInteger(st?.restart?.webPort),
    JSON.stringify(st?.restart).slice(0, 240));
  const ver = await rpc('restore', { selector: archive, dryRun: true });
  check('恢复后同一归档可再次 dry-run 预览（数据自洽）', ver?.ok === true && ver?.dryRun === true);
  const sessPath = path.join(home, 'sessions', '_no-cwd', 'sess-rh', 'session.jsonl.zstd');
  const sessBack2 = fs.existsSync(sessPath) && fs.readFileSync(sessPath).equals(healthy);
  check('恢复后会话内容与备份一致（字节级）', sessBack2);

  // ---------- 6) 交接指令字段（部署期武装路径，不真正执行）----------
  // 部署期恢复立即返回 stopCmd/relaunchCmd/offlineCmd；用长延时武装后立刻写
  // 中止文件取消，既验证字段与内容，又不会真的停宿主。
  const armed = await rpc('restore', { selector: archive, dryRun: false, deploy: true, deployDelay: 900 }, 60000);
  const cmdsOk = armed?.ok === true && armed?.deployRestore === true
    && typeof armed?.stopCmd === 'string' && armed.stopCmd.includes('stop') && armed.stopCmd.includes('ops.mjs')
    && typeof armed?.relaunchCmd === 'string' && /node/i.test(armed.relaunchCmd)
    && typeof armed?.offlineCmd === 'string' && armed.offlineCmd.includes('deploy-restore');
  check('面板恢复返回成对可复制指令（stop/relaunch/offline）', cmdsOk, JSON.stringify({ stop: armed?.stopCmd, relaunch: armed?.relaunchCmd, offline: armed?.offlineCmd }).slice(0, 400));
  check('summary 里含“先停旧再启新”两条指令', typeof armed?.summary === 'string' && armed.summary.includes('停止旧宿主') && armed.summary.includes('启动新宿主'));
  if (armed?.abortFile) fs.writeFileSync(armed.abortFile, 'cancel');
  check('已写中止文件取消本次武装（不执行停机恢复）', Boolean(armed?.abortFile) && fs.existsSync(armed.abortFile));

  await stopBoot();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(`❌ ${err && err.message ? err.message : err}`); process.exitCode = 1; })
  .finally(async () => { await stopBoot(); });
