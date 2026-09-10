#!/usr/bin/env node
/**
 * gate-boot：装配门。在**隔离的 DSH_HOME** 里把指定插件 spec 装进一个最小 profile，
 * 然后真启动一次宿主，确认插件树能装配（这是唯一能挡住
 * `cannot get property "x" without inject` / `xxx is not defined` 这类错误的门——
 * 它们只在真宿主里炸，而一旦炸了用户整个 dsh web 就起不来）。
 *
 * 用法:
 *   node gate-boot.mjs --spec "github:owner/repo#v1.2.3" [--timeout 120] [--json]
 * 输出: 人类可读摘要；--json 时只输出一行 JSON { ok, spec, home, reason, bootOk, installOk }
 * 退出码: 0 = 门通过；1 = 未通过；2 = 参数/环境错误
 *
 * 只依赖 node 内置模块；被 dsh-backup 的升级事务调用，也可单独跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SPEC = argOf('--spec', '');
const TIMEOUT_S = Number(argOf('--timeout', '120'));
const AS_JSON = argv.includes('--json');
// --exit-zero：无论门是否通过都退 0，把结论放在 JSON 里——给上层编排（upgradeRun）用，
// 免得调用方还要从异常里抠结论。CLI 手工用时不要加这个参数。
const EXIT_ZERO = argv.includes('--exit-zero');
const PORT = Number(argOf('--port', String(13200 + Math.floor(Math.random() * 400))));
const DSH_BIN = argOf('--dsh-bin', defaultDshBin());

function defaultDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null,
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function emit(ok, extra = {}) {
  const out = { ok, spec: SPEC, ...extra };
  if (AS_JSON) console.log(JSON.stringify(out));
  else {
    console.log(`${ok ? '✅' : '❌'} 装配门 ${ok ? '通过' : '未通过'}: ${SPEC}`);
    if (out.installOk !== undefined) console.log(`   安装: ${out.installOk ? 'ok' : '失败'}`);
    if (out.bootOk !== undefined) console.log(`   启动: ${out.bootOk ? 'ok' : '失败'}`);
    if (out.reason) console.log(`   原因: ${out.reason}`);
    if (out.home) console.log(`   隔离 home: ${out.home}`);
  }
  process.exit(ok || EXIT_ZERO ? 0 : 1);
}

if (!SPEC) { console.error('用法: node gate-boot.mjs --spec "<install spec>" [--timeout 120] [--json]'); process.exit(2); }
if (!DSH_BIN) { console.error('找不到 dsh CLI：请用 --dsh-bin <path> 或设置 DSH_BIN'); process.exit(2); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-'));
const webDir = path.join(home, 'profiles', 'web');
fs.mkdirSync(webDir, { recursive: true });
fs.writeFileSync(path.join(webDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-gate-profile',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
}, null, 2)}\n`);
fs.writeFileSync(path.join(webDir, 'cordis.yml'), '[]\n');
fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), [
  '# gate-boot isolated profile', '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${PORT}`, '',
].join('\n'));

const env = { ...process.env, DSH_HOME: home, DSH_WEB_URL: `http://127.0.0.1:${PORT}` };

// 1) 在隔离 profile 里安装该 spec（真实走 pnpm，与线上安装同路径）
const inst = spawnSync(process.execPath, [DSH_BIN, 'plugin', '--profile', 'web', 'add', SPEC], {
  env, encoding: 'utf8', timeout: Math.max(120_000, TIMEOUT_S * 1000), windowsHide: true,
});
const installOk = inst.status === 0;
if (!installOk) {
  emit(false, {
    installOk: false, home,
    reason: `安装失败（exit ${inst.status}）：${String(inst.stderr || inst.stdout || inst.error?.message || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`,
  });
}

// 2) 真启动一次宿主，等它打印 web 地址；绑定失败/插件树失败都会立刻退出
const logPath = path.join(home, 'boot.log');
const logFd = fs.openSync(logPath, 'w');
const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open', '--port', String(PORT)], {
  env, stdio: ['ignore', logFd, logFd], windowsHide: true,
});
let exited = null;
child.on('exit', (code) => { exited = code; });
const started = Date.now();
let bootOk = false;
while (Date.now() - started < TIMEOUT_S * 1000) {
  if (exited !== null) break;
  const log = fs.readFileSync(logPath, 'utf8');
  if (/dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(log)) { bootOk = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
const log = fs.readFileSync(logPath, 'utf8');
try { child.kill(); } catch { /* 已退出 */ }
await new Promise((r) => setTimeout(r, 600));
try { fs.closeSync(logFd); } catch { /* 忽略 */ }

if (!bootOk) {
  const detail = log.split('\n').filter((l) => /Error|error|without inject|not defined|failed to/.test(l)).slice(0, 4).join(' | ');
  emit(false, { installOk: true, bootOk: false, home, reason: (detail || `启动 ${TIMEOUT_S}s 内未就绪（exit=${exited}）`).slice(0, 400) });
}
emit(true, { installOk: true, bootOk: true, home });
