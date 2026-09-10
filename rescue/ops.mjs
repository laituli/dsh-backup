#!/usr/bin/env node
/**
 * dsh-backup fork 增量：运维动作入口（**非**上游救援通道）。
 *
 * 为什么独立成文件：`stop` 服务的是「宿主机还在跑、从 GUI/面板重启或做停机窗口」
 * 这个场景，与上游 `rescue.mjs`（宿主起不来时的离线求生卡）不是同一场景。
 * 上游文件保持原样，我们的能力放这里，跟随上游合并时零冲突。
 *
 * 用法:
 *   node ops.mjs stop --web-port 3080
 *       按端口找到 dsh 宿主进程并结束、等端口释放（宿主不在则幂等跳过）。
 *   node ops.mjs deploy-restore <前缀|latest> --yes [--delay N] [--pid N]
 *       停机窗口恢复：等 arm 文件 → 延时 → 停宿主 → 调 rescue.mjs 从归档恢复。
 *   node ops.mjs --help
 *
 * 恢复本身**委托给同目录的 rescue.mjs**（upstream），本文件只做编排，不重复实现。
 * 零依赖；退出码 0=成功，1=用法/环境错误，3=中止，4=等待 arm 超时。
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HELP = `dsh-backup ops —— 运维动作（重启/停机窗口恢复；非上游救援通道）

用法:
  node ops.mjs stop --web-port <端口>
      停止监听该端口的 dsh 宿主并等端口释放（幂等：没在跑就跳过）
  node ops.mjs deploy-restore <前缀|latest> --yes [选项]
      停机窗口恢复：等 arm 文件 → 延时 → 停宿主 → 调 rescue.mjs 恢复
  node ops.mjs --help

选项（deploy-restore）:
  --root <目录>      备份目录（缺省 = 本文件所在目录）
  --delay N          延时秒数（缺省 60；延时期间宿主保持运行）
  --pid N            要停止的宿主 PID（缺省按 --web-port 找占用者）
  --web-port N       宿主监听端口（缺省 3080）
  --settle N         宿主停止后的宽限秒数（缺省 8）
  --max-wait N       等待宿主停止上限秒数（缺省 120）
  --arm-file PATH    等此文件出现才开始倒计时（宿主确认空闲后写入）
  --arm-timeout N    arm 等待上限秒数（缺省 1800，超时 exit 4）
  --abort-file PATH  中止文件（存在则取消，exit 3）`;

// ---------- 宿主进程定位 / 停止 ----------

async function tcpListening(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (IS_WIN) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
    return r.status === 0 && String(r.stdout).includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidOnPort(port) {
  if (IS_WIN) {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const needle = `:${port}`;
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && /^TCP$/i.test(parts[0]) && parts[1]?.endsWith(needle) && /LISTENING/i.test(parts[3])) {
        const found = Number(parts[4]);
        if (Number.isFinite(found) && found > 0) return found;
      }
    }
    return null;
  }
  try {
    const r = spawnSync('lsof', ['-tiTCP', String(port), '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (r.status === 0) {
      const found = Number(String(r.stdout).trim().split(/\s+/)[0]);
      if (Number.isFinite(found) && found > 0) return found;
    }
  } catch { /* 无 lsof 时按 pid 主路径 */ }
  return null;
}

async function killPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (IS_WIN) { spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8' }); return; }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  await sleep(1500);
  if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
}

async function waitPortDown(port, maxWaitMs, settleMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!(await tcpListening(port))) {
      if (settleMs > 0) await sleep(settleMs);
      if (!(await tcpListening(port))) return true;
    }
    await sleep(500);
  }
  return !(await tcpListening(port));
}

/** 停止宿主：优先给定 PID，进程不在时按端口兜底找占用者。 */
async function stopHost({ pid, port, maxWaitSec, settleSec }) {
  const portNum = Number(port) || 3080;
  const owner = await pidOnPort(portNum);
  if (owner && pidAlive(owner)) {
    if (Number.isFinite(pid) && owner !== Number(pid)) console.log(`⚠️ 端口 ${portNum} 被另一进程 PID=${owner} 占用，将一并停止`);
    if (owner === Number(pid)) console.log(`⏹ 停止宿主进程 PID=${owner}`);
    await killPid(owner);
  } else if (pidAlive(Number(pid))) {
    console.log(`⏹ 停止宿主进程 PID=${pid}`);
    await killPid(Number(pid));
  } else {
    console.log(`ℹ️ 未发现需停止的宿主进程（PID=${pid ?? '-'}，端口 ${portNum} 无监听），继续`);
  }
  if (await tcpListening(portNum)) {
    const down = await waitPortDown(portNum, (maxWaitSec || 120) * 1000, settleSec ?? 8);
    if (!down) throw new Error(`等待宿主停止超时（端口 ${portNum} 仍在监听），已中止`);
  }
  return true;
}

// ---------- deploy-restore：等 arm → 延时 → 停宿主 → 委托 rescue 恢复 ----------

function argVal(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function numArg(argv, name, fallback) {
  const v = argVal(argv, name);
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function deployRestore(argv) {
  const root = argVal(argv, '--root') || SELF_DIR;
  const selector = (() => {
    const skip = new Set();
    for (const name of ['--root', '--delay', '--pid', '--web-port', '--settle', '--max-wait', '--arm-file', '--arm-timeout', '--abort-file']) {
      const i = argv.indexOf(name);
      if (i >= 0) { skip.add(i); skip.add(i + 1); }
    }
    // 跳过命令名本身（argv 里第一个非 -- 开头的 token 是 'deploy-restore'）
    const cmdIndex = argv.findIndex((a) => !a.startsWith('--'));
    return argv.find((a, i) => i !== cmdIndex && !skip.has(i) && !a.startsWith('--')) ?? 'latest';
  })();
  const delaySec = numArg(argv, '--delay', 60);
  const settleSec = numArg(argv, '--settle', 8);
  const maxWaitSec = numArg(argv, '--max-wait', 120);
  const port = numArg(argv, '--web-port', 3080);
  const pid = Number(argVal(argv, '--pid'));
  const armFile = argVal(argv, '--arm-file');
  const abortFile = argVal(argv, '--abort-file');
  const armTimeoutSec = numArg(argv, '--arm-timeout', 1800);

  console.log(`🚀 deploy-restore：归档=${selector} 延时=${delaySec}s 端口=${port} 宿主PID=${Number.isFinite(pid) ? pid : '-'}${armFile ? ` arm文件=${armFile}` : ''}`);
  const aborted = async () => {
    if (!abortFile) return false;
    try { await fs.promises.stat(abortFile); return true; } catch { return false; }
  };

  if (await aborted()) { console.error('❌ 检测到中止文件，已取消（未做任何写入）'); process.exitCode = 3; return; }
  if (armFile) {
    const deadline = Date.now() + armTimeoutSec * 1000;
    while (Date.now() < deadline) {
      try { await fs.promises.stat(armFile); break; } catch { /* 尚未 armed */ }
      await sleep(2000);
    }
    const armed = await fs.promises.stat(armFile).then(() => true, () => false);
    if (!armed) { console.error(`❌ 等待宿主 armed 超时（${armTimeoutSec}s 内未见 ${armFile}），已取消`); process.exitCode = 4; return; }
    console.log('🟢 宿主已确认空闲（arm 文件出现），开始延时倒计时');
  }
  if (delaySec > 0) {
    console.log(`⏳ 延时 ${delaySec}s（宿主保持运行，期间可放中止文件取消）…`);
    await sleep(delaySec * 1000);
  }
  if (await aborted()) { console.error('❌ 延时结束前出现中止文件，已取消'); process.exitCode = 3; return; }

  await stopHost({ pid, port, maxWaitSec, settleSec });
  console.log('📦 宿主已停止，委托 rescue.mjs 恢复…');
  const rescue = path.join(SELF_DIR, 'rescue.mjs');
  if (!fs.existsSync(rescue)) { console.error(`❌ 找不到 rescue.mjs（${rescue}）：恢复本身由上游救援通道执行，请确认它随包安装`); process.exitCode = 1; return; }
  const r = spawnSync(process.execPath, [rescue, 'restore', selector, '--yes', '--root', root], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`❌ rescue restore 失败（exit ${r.status}）`); process.exitCode = r.status ?? 1; return; }
  console.log('✅ 停机窗口恢复完成。请用带 DSH_HOME/cwd 的启动指令重新启动 dsh。');
}

// ---------- CLI ----------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('--')) ?? (argv.includes('--help') || argv.includes('-h') ? 'help' : '');
  if (!cmd || cmd === 'help') { console.log(HELP); return; }

  if (cmd === 'stop') {
    const port = numArg(argv, '--web-port', numArg(argv, '--port', 3080));
    console.log(`⏹ 停止监听端口 ${port} 的 dsh 宿主…`);
    await stopHost({ pid: undefined, port, maxWaitSec: 120, settleSec: 8 });
    console.log('✅ 旧宿主已停止（端口已释放）。现在可以启动新的 dsh。');
    return;
  }

  if (cmd === 'deploy-restore') {
    if (!argv.includes('--yes')) {
      console.log(`📦 预览模式（未加 --yes，不做任何写入）\n确认无误后执行: node ops.mjs deploy-restore ${argVal(argv, '--root') ? '' : '<前缀|latest> '}--yes --root <备份目录>`);
      return;
    }
    await deployRestore(argv);
    return;
  }

  console.error(`未知命令: ${cmd}\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
