/**
 * 客户端半边冒烟测试（零依赖除 devDeps 的 react/react-dom/zod）。
 *
 * 1. 以 Web shell 的握手方式加载 lib/client.js（window.__ModuleLoader__ 工厂）。
 * 2. apply() 挂载：字典注册、Remote 贡献（strict zod）、Settings 标签页注册。
 * 3. 用真实 zod 校验每个结果 schema 能解析宿主面板返回的样例负载。
 * 4. react-dom/server SSR 渲染标签页（loading 态 + 通过注入 panel 的结构断言）。
 *
 * 用法：node scripts/smoke-client.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as z from 'zod';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failures += 1;
}

async function main() {
  console.log('1) ModuleLoader 握手加载 bundle');
  let entry;
  globalThis.window = { __ModuleLoader__: { load: (e) => { entry = e; } } };
  const bundle = await readFile(path.join(REPO, 'lib', 'client.js'), 'utf8');
  new Function(bundle)(); // bundle 顶层只声明 var 并调用 window.__ModuleLoader__.load
  const pkgName = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8')).name;
  ok(entry !== undefined && entry.id === pkgName, `bundle 以 id=${entry?.id} 注册`);

  const requireShim = (id) => {
    if (id === 'react') return require('react');
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
    // 槽标签解析由平台模块提供；这里给出与内置实现同形的实现即可。
    if (id === '@deepseek-ai/dsh-client-ui-slots') {
      return { resolveSlotLabel: (label) => (typeof label === 'function' ? label() : label ?? '') };
    }
    throw new Error(`意外的外部依赖: ${id}`);
  };
  const plugin = entry.factory(requireShim);
  ok(plugin.name === pkgName && JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale', 'remote']), `插件导出面正确: ${plugin.name}`);
  console.log('2) apply() 挂载（字典 / Remote 贡献 / 运维区块与子页）');
  const dict = {};
  const contributions = [];
  /** 已注册的槽条目：{ slot, reg, component }。 */
  const slotEntries = [];
  let scopedCallback = null;

  const ctx = {
    effect: (fn) => { const dispose = fn(); return () => dispose?.(); },
    locale: {
      register: (ns, d) => { dict[ns] = d; return () => {}; },
      bind: (ns) => (key) => dict[ns]?.zh?.[key] ?? key,
      subscribe: () => () => {},
    },
    remote: {
      $mount: async (c) => { contributions.push(c); return async () => {}; },
    },
    slots: {
      inject: (slotName, registrar) => { slotEntries.push({ slot: slotName, ...registrar() }); },
      register: (reg, component) => ({ ...reg, component }),
    },
    inject: (names, cb) => { if (names.includes('remote.backupPanel')) scopedCallback = cb; },
  };

  globalThis.document = {
    createElement: () => ({ style: {}, dataset: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
    querySelector: () => null,
    head: { append() {} },
  };
  await plugin.apply(ctx);
  delete globalThis.document;

  ok(dict['settings.backupPanel']?.zh?.tab === '备份' && dict['settings.backupPanel']?.en?.tab === 'Backup', '双语文典已注册');

  const contribution = contributions[0];
  ok(contribution?.package === 'dsh-backup' && contribution.descriptors.length === 11, `Remote 贡献含 ${contribution?.descriptors.length} 个端点`);

  const endpoints = contribution.descriptors.map((d) => `${d.namespace}/${d.method}`);
  ok(JSON.stringify(endpoints) === JSON.stringify(['backupPanel/status', 'backupPanel/backup', 'backupPanel/verify', 'backupPanel/restore', 'backupPanel/setAuto', 'backupPanel/githubStatus', 'backupPanel/githubSyncNow', 'backupPanel/githubPull', 'backupPanel/removeEntry', 'backupPanel/setGithubRepo', 'backupPanel/cancelSync']), `端点与宿主半边一致: ${endpoints.join(', ')}`);

  console.log('3) strict schema 解析宿主样例负载');
  const samples = {
    'backupPanel/status': {
      destination: 'C:/Users/u/Desktop/dsh-backups', dshHome: 'C:/Users/u/.dsh',
      keepDefault: 7, autoHours: 3, lastAuto: null,
      backups: [{ name: 'dsh-20260815-095739228.tar.gz', size: 12345 }, { name: 'dsh-x.tar.gz', size: null }],
    },
    'backupPanel/backup': { ok: true, summary: '备份完成', path: '/x/dsh-1.tar.gz', sha: 'ab'.repeat(32), stale: 1, keep: 7 },
    'backupPanel/verify': { ok: false, summary: '❌', results: [{ name: 'dsh-1.tar.gz', ok: false, note: 'sha256 不匹配' }] },
    'backupPanel/restore': { ok: true, dryRun: true, archive: '/x/dsh-1.tar.gz', files: 5, sample: ['.dsh/settings.json'], summary: '5 项' },
    'backupPanel/setAuto': { ok: true, hours: 3, summary: '已开启' },
    'backupPanel/githubStatus': { repoRaw: 'u/backups', repo: 'https://github.com/u/backups.git', tokenSet: true, syncDir: 'C:/x/.github-sync', lastPush: '2026-08-15T10:00:00.000Z', lastError: null },
    'backupPanel/githubSyncNow': { ok: true, summary: '无变更', pushed: false, tooBig: [] },
    'backupPanel/githubPull': { ok: true, summary: '已拉取 1 份备份', pulled: ['dsh-x.tar.gz'], corrupt: [], total: 1 },
    'backupPanel/removeEntry': { ok: true, summary: '已删除备份: dsh-x.tar.gz' },
    'backupPanel/setGithubRepo': { ok: true, repo: 'u/backups', summary: '已设为 u/backups' },
    'backupPanel/cancelSync': { ok: true, summary: '已请求取消「git-push」：当前这次尝试结束后立即停止重试' },
  };
  for (const d of contribution.descriptors) {
    const key = `${d.namespace}/${d.method}`;
    try {
      d.result.schema.parse(samples[key]);
      ok(true, `${key} 结果 schema 解析样例通过`);
    } catch (err) {
      ok(false, `${key} 结果 schema 解析失败: ${String(err)}`);
    }
  }
  ok(contribution.descriptors.every((d) => d.parameters.every((p) => p.codec.mode === 'strict' && p.codec.schema)), '参数全部 strict codec（客户端挂载校验要求）');

  console.log('4) 运维区块 / 子页注册与 SSR 渲染');
  {
    const opsSection = slotEntries.find((entry) => entry.slot === 'settings.section' && entry.id === 'ops');
    ok(opsSection?.name === 'settings.section', `运维区块注册到 settings.section: id=${opsSection?.id}`);
    ok(JSON.stringify(Object.keys(opsSection?.children ?? {})) === JSON.stringify(['dsh-backup.ops.tab']), `区块声明子页槽: ${Object.keys(opsSection?.children ?? {}).join(', ')}`);
    ok(typeof opsSection?.label === 'function' && opsSection.label() === '运维', `区块标签: ${opsSection?.label?.()}`);
    const backupTab = slotEntries.find((entry) => entry.slot === 'dsh-backup.ops.tab' && entry.id === 'ops-backup');
    ok(backupTab?.name === 'dsh-backup.ops.tab' && typeof backupTab?.label === 'function' && backupTab.label() === '备份', `备份子页注册到运维槽: id=${backupTab?.id}, label=${backupTab?.label?.()}`);
    ok(slotEntries.every((entry) => entry.slot !== 'settings.plugins.tab'), '不再向「插件」区注册备份标签页（已整体迁到运维）');
  }

  if (scopedCallback === null) { ok(false, 'remote.backupPanel 作用域未激活'); }
  else {
    const calls = { status: 0 };
    const fakeNamespace = {
      status: async () => ({ ok: true, value: samples['backupPanel/status'] }),
      backup: async () => ({ ok: true, value: samples['backupPanel/backup'] }),
      verify: async () => ({ ok: true, value: samples['backupPanel/verify'] }),
      restore: async () => ({ ok: true, value: samples['backupPanel/restore'] }),
      setAuto: async () => ({ ok: true, value: samples['backupPanel/setAuto'] }),
      githubStatus: async () => ({ ok: true, value: samples['backupPanel/githubStatus'] }),
      githubSyncNow: async () => ({ ok: true, value: samples['backupPanel/githubSyncNow'] }),
      githubPull: async () => ({ ok: true, value: samples['backupPanel/githubPull'] }),
      removeEntry: async () => ({ ok: true, value: samples['backupPanel/removeEntry'] }),
      setGithubRepo: async () => ({ ok: true, value: samples['backupPanel/setGithubRepo'] }),
    };
    const scope = {
      locale: {
        bind: (ns) => (key) => {
          calls.status += 0;
          return dict[ns]?.zh?.[key] ?? key;
        },
      },
      remote: { backupPanel: fakeNamespace },
    };
    scopedCallback(scope);
    const tab = slotEntries.find((entry) => entry.id === 'ops-backup');
    ok(typeof tab?.component === 'function' || typeof tab === 'function', '备份子页组件可渲染');
    const Component = tab?.component ?? tab;
    const injected = tab.inject();
    ok(injected.panel === undefined || (typeof injected.panel?.status === 'function' && typeof injected.panel?.restore === 'function'), '注入面暴露 panel API（或未就绪时保持 undefined，由组件显示错误+重试）');
    const panelApi = injected.panel ?? {
      status: async () => samples['backupPanel/status'],
      githubStatus: async () => samples['backupPanel/githubStatus'],
    };

    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const markup = renderToStaticMarkup(React.createElement(Component, { panel: panelApi, t: scope.locale.bind('settings.backupPanel') }));
    ok(markup.includes('data-dsh-backup') && markup.includes('正在读取备份状态'), 'SSR 渲染出备份子页骨架（loading 态）');
  }

  console.log(`\n结果: ${checks - failures}/${checks} 通过`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
