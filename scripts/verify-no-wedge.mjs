#!/usr/bin/env node
/**
 * 验证「命令永不悬挂」与「悬挂命令可封口」这两条硬约束。
 *
 * 背景（2026-09-10 真实事故）：/backup 内联等待 git push（旧版无超时），宿主被强杀后
 * 会话日志里只剩 command/run、没有 command/done → 界面永远显示「备份 进行中」，
 * 该会话的 /compact 与聊天消息一起被挡住。本脚本对三类失败面各下一道断言：
 *
 *   A. 网络不通用：命令/面板**秒级结算**，慢活转后台任务（进度/取消可见）
 *   B. 任意一步真卡死：命令出口的硬截止时间把它收成「已超时」，绝不悬挂
 *   C. 已经悬挂的历史日志：doctor --seal 追加一条 command/done 把它结清
 *      （追加帧、seq 接续、保留首帧 header 契约、原文件留档、可重复执行）
 *
 * 用法: node scripts/verify-no-wedge.mjs
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const plugin = (await import(new URL('../lib/index.js', import.meta.url).href)).apply;

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}`); }
};

/** 最小 ctx 桩：只需 commands/tools/subprocess/launchEnvironment/inject/on。 */
function makeCtx({ home, dsh, hangTar = false, hangGit = false }) {
  const handlers = new Map();
  const services = [];
  const disposers = [];
  let tool = null;
  const never = new Promise(() => {});

  const collectedFor = () => ({
    stdout: { readFrom: () => ({ get text() { return ''; } }) },
    stderr: { readFrom: () => ({ get text() { return ''; } }) },
  });

  const ctx = {
    get: (key) => (key === 'launchEnvironment' ? {
      get: (name) => {
        if (name === 'HOME' || name === 'USERPROFILE') return { value: home };
        if (name === 'DSH_HOME') return { value: dsh };
        return undefined;
      },
    } : undefined),
    subprocess: {
      // 与 smoke 同款桩：Windows 上只认 tar/git（哈希走插件内置的 node:crypto 分支），
      // 其余解析失败——保证"真宿主缺什么"在这里也能暴露。
      resolveExecutable: async (name) => {
        if (process.platform === 'win32') {
          if (name === 'tar' || name === 'git') return name;
          throw new Error(`mock: ${name} not found on win32`);
        }
        return name;
      },
      spawn: (spec) => {
        const bin = String(spec.argv[0]);
        if ((hangTar && bin === 'tar') || (hangGit && bin === 'git')) {
          return { done: never, collected: collectedFor(), terminate: () => {} };
        }
        const child = spawn(bin, spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const onAbort = () => child.kill();
        spec.signal?.addEventListener('abort', onAbort, { once: true });
        const done = new Promise((resolve) => {
          child.on('close', (code) => {
            spec.signal?.removeEventListener('abort', onAbort);
            resolve(code === null ? { exitCode: null, signal: 'SIGTERM' } : { exitCode: code, signal: null });
          });
        });
        return {
          done,
          terminate: () => child.kill(),
          collected: {
            stdout: { readFrom: () => ({ get text() { return out; } }) },
            stderr: { readFrom: () => ({ get text() { return err; } }) },
          },
        };
      },
    },
    on: (event, cb) => { if (event === 'dispose') disposers.push(cb); return () => {}; },
    commands: { register: (cmd) => handlers.set(cmd.name, cmd.handler) },
    tools: { register: (t) => { tool = t; } },
    interval: () => () => {},
    timeout: () => () => {},
    inject: (names, callback) => {
      if (names.includes('typert')) {
        const scope = {
          typert: { register: (c) => { services.push(c); return () => {}; } },
          effect: (fn) => { const d = fn(); return () => d?.(); },
          plugin: (Class, opts) => { const inst = new Class(scope, opts); services.push(inst); return inst; },
        };
        callback(scope);
      }
      if (names.includes('settings')) {
        let base = {};
        callback({
          settings: {
            register: (_ns, _schema, opts) => { base = (opts && opts.base) || {}; },
            update: () => {},
            replace: () => {},
            describe: () => [{ ns: 'dsh-backup', revision: 0, value: { ...base } }],
          },
        });
      }
    },
  };
  return {
    ctx,
    handler: (raw, signal) => handlers.get('backup')({ rawInput: raw, signal }),
    service: () => services.find((s) => s && s.constructor && s.constructor.name === 'BackupPanelService'),
    dispose: () => { for (const cb of disposers) { try { cb(); } catch { /* 忽略 */ } } },
    tool: () => tool,
  };
}

/** 造一份「append 批次 = 独立 zstd 帧」的会话日志，首帧恰好一行 header。 */
async function writeSessionLog(dir, batches) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl.zstd');
  const frames = batches.map((lines) => zlib.zstdCompressSync(Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf8')));
  const buf = Buffer.concat(frames);
  await writeFile(file, buf);
  // 让它"看起来像过去写的"（封口会跳过 2 分钟内仍在写入的日志）
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(file, old, old);
  return { file, originalSize: buf.length, firstFrameSize: frames[0].length };
}

/** 逐帧解压（测试自造的帧边界已知，直接按记录的长度切）。 */
function decodeBatches(buf, frames) {
  const lines = [];
  let off = 0;
  for (const size of frames) {
    lines.push(...zlib.zstdDecompressSync(buf.subarray(off, off + size)).toString('utf8').split('\n').filter(Boolean));
    off += size;
  }
  return lines;
}

async function main() {
  const base = path.join(tmpdir(), `dsh-nowedge-${randomUUID().slice(0, 8)}`);
  const home = path.join(base, 'home');
  const dsh = path.join(home, '.dsh');
  await mkdir(dsh, { recursive: true });
  const dest = path.join(home, 'Desktop', 'dsh-backups');

  try {
    console.log('A) 网络不通时：命令/面板必须秒级结算（慢活转后台）');
    {
      const m = makeCtx({ home, dsh });
      // 指向一个不存在的裸仓库：同步必然失败并进入重试——正是当年卡死的形状
      plugin(m.ctx, { destination: dest, githubRepo: path.join(base, 'no-such-bare.git').split(path.sep).join('/') });
      const t0 = Date.now();
      const r = await m.handler('');
      const dt = Date.now() - t0;
      ok(r.kind === 'success' && r.text.includes('备份完成'), '备份本身成功（网络失败不影响归档）');
      ok(dt < 15000, `命令秒级返回（实测 ${dt}ms）`);
      ok(/后台/.test(r.text), '回执明确说明同步已转后台');
      const st = await m.handler('github status');
      ok(st.kind === 'success' && /后台进行中/.test(st.text), 'github status 报告后台任务进行中');
      const svc = m.service();
      const panelStatus = await svc.status();
      ok(panelStatus.sync && panelStatus.sync.state === 'running', '面板 status.sync 反映后台任务在跑');
      const t1 = Date.now();
      const cancel = await m.handler('github cancel');
      ok(cancel.kind === 'success' && Date.now() - t1 < 5000, 'github cancel 立刻受理（不等待网络）');
      m.dispose();
      // 取消后后台任务应尽快收敛，避免测试进程挂着重试定时器
      await new Promise((r2) => setTimeout(r2, 1200));
    }

    console.log('B) 任意一步真卡死：命令出口的硬截止时间必须把它收成「已超时」');
    {
      const m = makeCtx({ home, dsh, hangTar: true });
      process.env.DSH_BACKUP_CMD_DEADLINE_SEC = '5';
      plugin(m.ctx, { destination: dest });
      const t0 = Date.now();
      const r = await m.handler('');
      const dt = Date.now() - t0;
      delete process.env.DSH_BACKUP_CMD_DEADLINE_SEC;
      ok(r.kind === 'error' && /超时|未完成/.test(r.text), `卡死的 tar 步骤被截止时间收口（kind=${r.kind}）`);
      ok(dt >= 4500 && dt < 20000, `超时后立刻结算（实测 ${dt}ms，期望 ≈5000ms）`);
      ok(/不会因此损坏|数据不会/.test(r.text), '超时文案说明数据不受影响并给出后续入口');
      m.dispose();
    }

    console.log('C) 已悬挂的历史日志：doctor --seal 追加 done 结清');
    {
      const projDir = path.join(dsh, 'sessions', '--proj--', 'session-testdangling');
      const header = { type: 'session', version: 0, id: 'session-testdangling', createdAt: Date.now() - 3600000, cwd: home, delegationDepth: 0, agentPreset: 'standard' };
      const batchSizes = [zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')).length];
      const recs = [
        { type: 'turn/start', seq: 0, time: Date.now() - 3600000, data: { turn: 1 } },
        { type: 'command/run', seq: 1, time: Date.now() - 3590000, data: { commandId: 'cmd-dead-1', name: 'backup', args: '', source: { kind: 'user' } } },
        { type: 'turn/end', seq: 2, time: Date.now() - 3580000, data: { turn: 1, reason: { kind: 'completed' } } },
      ];
      const second = zlib.zstdCompressSync(Buffer.from(recs.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8'));
      batchSizes.push(second.length);
      const { file, originalSize, firstFrameSize } = await writeSessionLog(projDir, [batchSizes.length ? [header] : [], recs]);
      const readLines = async () => {
        const buf = await readFile(file);
        const lines = decodeBatches(buf, batchSizes);
        // 封口会追加新帧：把它也解出来（插件一次追加一帧）
        if (buf.length > originalSize) {
          lines.push(...zlib.zstdDecompressSync(buf.subarray(originalSize)).toString('utf8').split('\n').filter(Boolean));
        }
        return lines;
      };
      const before = await readLines();
      ok(before.filter((l) => l.includes('command/done')).length === 0, '构造的日志确实没有 command/done（悬挂现场）');

      const m = makeCtx({ home, dsh });
      plugin(m.ctx, { destination: dest, githubRepo: '' });

      const dry = await m.handler('doctor --seal --dry-run');
      ok(dry.kind === 'success' && /预览/.test(dry.text), '--dry-run 只预览不改文件');
      ok((await stat(file)).size === originalSize, '预览后文件字节未变');

      const seal = await m.handler('doctor --seal');
      ok(seal.kind === 'success' && /封口/.test(seal.text), 'doctor --seal 报告已封口');
      const afterLines = await readLines();
      const done = afterLines.map((l) => JSON.parse(l)).find((r) => r.type === 'command/done' && r.data?.commandId === 'cmd-dead-1');
      ok(Boolean(done), '追加了配对 command/done（commandId 一致）');
      ok(done && done.data.kind === 'error', '封口记录 kind=error（卡片收敛为「已中断」）');
      ok(done && done.seq === 3, `seq 严格接续（期望 3，实际 ${done?.seq}）`);
      const bufAfter = await readFile(file);
      const headerText = zlib.zstdDecompressSync(bufAfter.subarray(0, firstFrameSize)).toString('utf8');
      ok(headerText.split('\n').filter(Boolean).length === 1, '首帧仍是恰好一行 header（宿主 assertZstdHeaderFrame 契约）');
      const backups = (await readdir(projDir)).filter((n) => n.includes('.preseal-'));
      ok(backups.length === 1, `原日志已留档（${backups.join(', ') || '无'}）`);

      const doc = await m.handler('doctor');
      ok(doc.kind === 'success' && /健康/.test(doc.text), '封口后 doctor 复检：日志健康（seq 连续、帧可解）');

      const again = await m.handler('doctor --seal');
      ok(again.kind === 'success' && /未发现/.test(again.text), '重复执行幂等（不再重复封口）');
      m.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n结果: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
  process.exit(fail ? 1 : 0);
}

await main();
