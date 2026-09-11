#!/usr/bin/env node
/**
 * upgradePlan（面板「检查更新」）的**延迟**回归：交互式查询必须在有界时间内返回，
 * 网络不通时也要给出 reason，而不是把 RPC 拖到客户端超时。
 *
 * 事故：隔离门里 upgradePlan 超过 120s 未返回 → 面板上就是"点了检查更新没反应"。
 * 本脚本用最小 ctx 桩（真 git、真网络）测这条路径的耗时与结果形状。
 *
 * 用法: node scripts/verify-plan-latency.mjs [--budget-ms 60000]
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const plugin = (await import(new URL('../lib/index.js', import.meta.url).href)).apply;
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const BUDGET = Number(argOf('--budget-ms', '60000'));

let pass = 0; let fail = 0;
const ok = (cond, label) => { if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}`); } };

function makeCtx({ home, dsh }) {
  const handlers = new Map();
  const services = [];
  const ctx = {
    get: (key) => (key === 'launchEnvironment' ? {
      get: (n) => (n === 'HOME' || n === 'USERPROFILE' ? { value: home } : n === 'DSH_HOME' ? { value: dsh } : undefined),
    } : undefined),
    subprocess: {
      resolveExecutable: async (name) => name,
      spawn: (spec) => {
        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
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
        return { done, terminate: () => child.kill(), collected: { stdout: { readFrom: () => ({ get text() { return out; } }) }, stderr: { readFrom: () => ({ get text() { return err; } }) } } };
      },
    },
    on: () => () => {},
    commands: { register: (c) => handlers.set(c.name, c.handler) },
    tools: { register: () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    inject: (names, cb) => {
      if (names.includes('typert')) cb({ typert: { register: () => () => {} }, effect: (f) => () => {}, plugin: (K, o) => { const i = new K({ effect: (f) => () => {}, plugin: () => {} }, o); services.push(i); return i; } });
      if (names.includes('settings')) cb({ settings: { register: () => {}, update: () => {}, replace: () => {}, describe: () => [{ ns: 'dsh-backup', revision: 0, value: {} }] } });
    },
  };
  return { ctx, service: () => services.find((s) => s && s.constructor && s.constructor.name === 'BackupPanelService') };
}

const base = path.join(tmpdir(), `dsh-plan-${randomUUID().slice(0, 8)}`);
const home = path.join(base, 'home');
const dsh = path.join(home, '.dsh');
try {
  await mkdir(path.join(dsh, 'profiles', 'web'), { recursive: true });
  await writeFile(path.join(dsh, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-personal-workflow': 'github:laituli/dsh-personal-workflow#v0.1.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-personal-workflow'] } },
  }, null, 2));

  const m = makeCtx({ home, dsh });
  plugin(m.ctx, { destination: path.join(home, 'Desktop', 'dsh-backups') });
  const svc = m.service();
  ok(Boolean(svc), '面板服务已装配');

  const t0 = Date.now();
  const plan = await svc.upgradePlan(undefined);
  const dt = Date.now() - t0;
  console.log(`  [plan] 用时 ${dt}ms → ${JSON.stringify(plan).slice(0, 220)}`);
  ok(dt < BUDGET, `upgradePlan 在 ${BUDGET}ms 内返回（实际 ${dt}ms）`);
  ok(plan && plan.ok === true && Array.isArray(plan.plugins), '返回形状正确（ok + plugins）');
  const entry = (plan?.plugins ?? []).find((p) => p.name === 'dsh-personal-workflow');
  ok(Boolean(entry) && entry.spec.includes('github:'), '认出 git 源依赖并带上 spec');
  ok(entry?.current === 'v0.1.2', `当前 tag 解析正确（${entry?.current}）`);
  const reachable = entry?.reason === null;
  ok(reachable ? entry.latest !== null : Boolean(entry.reason), reachable
    ? `远端最新 tag = ${entry.latest}（网络可达）`
    : `网络不可达时如实给 reason：${entry.reason}`);
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n结果: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
