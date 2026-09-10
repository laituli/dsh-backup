/**
 * `dsh-backup` 浏览器半边：挂载 `backupPanel` Remote 贡献，并在 Settings 的
 * 「运维」区块（`settings.section`，id `ops`）注册 备份 / 重启 / 升级 三个子页，
 * 其中「备份」子页由本插件的 `dsh-backup.ops.tab` 槽提供。
 * 所有数据经 `remote.backupPanel` 命名空间往返——子页不持有其它 RPC，
 * 也不自带除展开/预览以外的状态。
 *
 * 本文件由 scripts/build-client.mjs 打包为 lib/client.js（CJS 工厂包裹，
 * React/Cordis/客户端 UI 包保持 external，zod 内联），无需在仓库内直接运行。
 */

import { z } from 'zod';
import { OpsSection, OpsBackupTab, RestartTab, UpgradeTab } from './ops.jsx';
import { zh, en } from './locales.js';
import { installPanelStyles } from './styles.js';
import pkg from '../package.json' with { type: 'json' };

/** 字典命名空间（本插件拥有）。 */
export const NS = 'settings.backupPanel';

/** 插件名：取自 package.json name，随包名变（fork 改名自动跟随）。 */
export const name = pkg.name;

/** 标签页读取的服务；`remote.backupPanel` 随本插件挂载贡献后出现。 */
export const inject = ['slots', 'locale', 'remote'];

const statusSchema = z.object({
  destination: z.string(),
  dshHome: z.string(),
  keepDefault: z.number().int(),
  autoHours: z.number().int(),
  lastAuto: z.string().nullable(),
  backups: z.array(z.object({
    name: z.string(),
    size: z.number().int().nullable(),
  })),
  typedBackups: z.array(z.object({
    name: z.string(),
    size: z.number().int().nullable(),
    types: z.array(z.string()),
  })).optional(),
  // 「重启 / 升级」卡片：停机+启动成对指令（老宿主无此字段 → optional）
  restart: z.object({
    webPort: z.number().int(),
    stopCmd: z.string(),
    relaunchCmd: z.string(),
  }).optional(),
});

const backupSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  path: z.string(),
  sha: z.string(),
  stale: z.number().int(),
  keep: z.number().int(),
  types: z.array(z.string()).optional(),
  hasCredentials: z.boolean().optional(),
});

const verifySchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  results: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    note: z.string(),
  })),
});

const restoreSchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean(),
  summary: z.string(),
  archive: z.string().nullable().optional(),
  files: z.number().int().nullable().optional(),
  aside: z.string().nullable().optional(),
  snapshotPath: z.string().nullable().optional(),
  sample: z.array(z.string()).optional(),
  // 恢复预检提示（🔐凭据/📦依赖/⚠️跨机）与目标是否已有数据——预览弹窗渲染用
  preflight: z.array(z.string()).optional(),
  targetExists: z.boolean().nullable().optional(),
  // 分类型 merge 恢复（types 非空时出现）
  merge: z.boolean().optional(),
  types: z.array(z.string()).optional(),
  willOverwrite: z.array(z.string()).optional(),
  restored: z.number().int().optional(),
  kept: z.array(z.string()).optional(),
  // 部署期恢复（deploy=true）：宿主武装后返回的凭据
  deployRestore: z.boolean().optional(),
  delaySec: z.number().int().optional(),
  pid: z.number().int().optional(),
  port: z.number().int().optional(),
  armFile: z.string().optional(),
  abortFile: z.string().optional(),
  // 恢复完成后的「人工交接」：可复制的完整指令（任意 shell 粘贴）。
  // stopCmd 先停旧宿主（rescue stop，跨平台幂等）；relaunchCmd 再启新 dsh；
  // offlineCmd 仅部署期恢复返回（自动执行器未生效时的手动停机恢复等价指令）。
  stopCmd: z.string().nullable().optional(),
  relaunchCmd: z.string().nullable().optional(),
  offlineCmd: z.string().nullable().optional(),
});

const setAutoSchema = z.object({
  ok: z.boolean(),
  hours: z.number().int(),
  summary: z.string(),
});

const githubStatusSchema = z.object({
  repoRaw: z.string().nullable(),
  repo: z.string().nullable(),
  tokenSet: z.boolean(),
  syncDir: z.string(),
  lastPush: z.string().nullable(),
  lastError: z.string().nullable(),
});

const githubSyncSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  pushed: z.boolean(),
  tooBig: z.array(z.string()),
});

const githubPullSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  pulled: z.array(z.string()),
  corrupt: z.array(z.string()),
  total: z.number().int(),
});

const removeSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
});

const setGithubRepoSchema = z.object({
  ok: z.boolean(),
  repo: z.string().nullable(),
  summary: z.string(),
});

const keepParam = { name: 'keep', wire: 'keep', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#keep', schema: z.number().int().positive().optional() }, acceptsUndefined: true };
const selectorParam = { name: 'selector', wire: 'selector', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#selector', schema: z.string().optional() }, acceptsUndefined: true };
const dryRunParam = { name: 'dryRun', wire: 'dryRun', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#dryRun', schema: z.boolean().optional() }, acceptsUndefined: true };
const syncDepsParam = { name: 'syncDeps', wire: 'syncDeps', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#syncDeps', schema: z.boolean().optional() }, acceptsUndefined: true };
const deployParam = { name: 'deploy', wire: 'deploy', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#deploy', schema: z.boolean().optional() }, acceptsUndefined: true };
const deployDelayParam = { name: 'deployDelay', wire: 'deployDelay', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#deployDelay', schema: z.number().int().min(0).optional() }, acceptsUndefined: true };
const hoursParam = { name: 'hours', wire: 'hours', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#hours', schema: z.number().int().min(0).max(720) }, acceptsUndefined: true };
const repoParam = { name: 'repo', wire: 'repo', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#repo', schema: z.string().optional() }, acceptsUndefined: true };
const typesParam = { name: 'types', wire: 'types', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#types', schema: z.array(z.string()).optional() }, acceptsUndefined: true };

function strictDescriptor(method, parameters, schema, cancellation) {
  return Object.freeze({
    id: `dsh-backup#backupPanel/${method}`,
    service: 'backupPanel',
    namespace: 'backupPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({ ...p, codec: Object.freeze(p.codec) }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'strict', typeSymbol: `dsh-backup/types#${method}Result`, schema }),
  });
}

/**
 * `backupPanel` 的客户端 Remote 贡献：与宿主半边（lib/index.js 的
 * PANEL_INVOCATIONS）共享同一组端点；此处携带 strict zod codec（客户端
 * 挂载校验强制 strict），宿主为 src-json——两端按同一 wire 契约工作。
 */
export const BACKUP_REMOTE = Object.freeze({
  package: 'dsh-backup',
  descriptors: Object.freeze([
    strictDescriptor('status', [], statusSchema, false),
    strictDescriptor('backup', [keepParam, typesParam], backupSchema, true),
    strictDescriptor('verify', [selectorParam], verifySchema, true),
    strictDescriptor('restore', [selectorParam, dryRunParam, typesParam, syncDepsParam, deployParam, deployDelayParam], restoreSchema, true),
    strictDescriptor('setAuto', [hoursParam], setAutoSchema, false),
    strictDescriptor('githubStatus', [], githubStatusSchema, false),
    strictDescriptor('githubSyncNow', [], githubSyncSchema, true),
    strictDescriptor('githubPull', [], githubPullSchema, true),
    strictDescriptor('removeEntry', [selectorParam], removeSchema, true),
    strictDescriptor('setGithubRepo', [repoParam], setGithubRepoSchema, false),
  ]),
});

function unwrap(result) {
  if (!result.ok) {
    const err = result.error;
    // 机器错误码不直接面向用户：给人话 + 折叠技术细节（文案审计 W3）
    const raw = err && err.message ? `${err.code}: ${err.message}` : 'backupPanel 调用失败';
    throw new Error(`操作没有完成：面板暂时连不上后台，请重试；若反复出现请重启 dsh web（技术细节: ${raw}）`);
  }
  return result.value;
}

/**
 * 浏览器插件主体：字典、样式表、Remote 贡献挂载、Settings 标签页注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-backup: dictionaries');
  ctx.effect(() => installPanelStyles(), 'dsh-backup: stylesheet');

  // apply 必须保持同步：宿主 Cordis 会卸载 async apply 里 await 之后注册的
  // ctx.effect（$mount 的 namespace 随即清空，tab 注册被级联销毁）。因此
  // $mount 在这里同步注册的 effect 工厂内部异步完成，失败落 console.error；
  // ctx.inject 与宿主插件一样留在同步帧。
  ctx.effect(() => {
    let mounted = null;
    let pending = true;
    let unloaded = false;
    void (async () => {
      try {
        mounted = await ctx.remote.$mount(BACKUP_REMOTE);
      } catch (error) {
        console.error('dsh-backup: backupPanel mount failed:', error);
      }
      pending = false;
      if (unloaded) void mounted?.();
    })();
    return () => {
      unloaded = true;
      if (!pending) void mounted?.();
    };
  }, 'dsh-backup: remote contribution');

  // 「运维」区块先于 Remote 挂载注册：即使 backupPanel Remote 因鉴权/连接异常
  // 没挂上，重启与升级两个子页仍然可用（它们的状态请求有界等待并自渲染错误），
  // 备份子页也会显示明确错误，而不是永久停在"正在读取备份状态…"。
  // panel 用容器对象传递：区块注册发生在前，API 就绪在后，槽渲染时读到的
  // 永远是最新值（未就绪即 undefined，组件据此显示错误+重试）。
  const panelHolder = { current: undefined };
  // 槽标签自己绑字典：不依赖框架回调传入的 locale 形态。
  const label = (key) => ctx.locale.bind(NS)(key);

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ops',
    order: 25,
    label: () => label('opsNav'),
    locale: NS,
    inject: () => ({ ctx, panel: panelHolder.current }),
    children: { 'dsh-backup.ops.tab': { kind: 'list', scope: 'root' } },
  }, OpsSection)), 'dsh-backup: ops section');

  ctx.effect(() => ctx.slots.inject('dsh-backup.ops.tab', () => ctx.slots.register({
    name: 'dsh-backup.ops.tab',
    id: 'ops-backup',
    order: 10,
    label: () => label('opsTabBackup'),
    locale: NS,
    inject: () => ({ panel: panelHolder.current }),
  }, OpsBackupTab)), 'dsh-backup: ops backup tab');

  // 重启 / 升级两个子页（此前只注册了备份，运维里只剩一个页签）：
  // panel 与 onBackup 由 OpsSection 经 childProps 透传，这里只需给出面板句柄。
  ctx.effect(() => ctx.slots.inject('dsh-backup.ops.tab', () => ctx.slots.register({
    name: 'dsh-backup.ops.tab',
    id: 'ops-restart',
    order: 20,
    label: () => label('opsTabRestart'),
    locale: NS,
    inject: () => ({ panel: panelHolder.current }),
  }, RestartTab)), 'dsh-backup: ops restart tab');

  ctx.effect(() => ctx.slots.inject('dsh-backup.ops.tab', () => ctx.slots.register({
    name: 'dsh-backup.ops.tab',
    id: 'ops-upgrade',
    order: 30,
    label: () => label('opsTabUpgrade'),
    locale: NS,
    inject: () => ({ panel: panelHolder.current }),
  }, UpgradeTab)), 'dsh-backup: ops upgrade tab');

  ctx.inject(['remote.backupPanel'], (scope) => {
    const t = scope.locale.bind(NS);
    const ns = () => scope.remote.backupPanel;
    const panel = {
      status: async () => unwrap(await ns().status()),
      backup: async (keep, types) => unwrap(await ns().backup(keep, types)),
      verify: async (selector) => unwrap(await ns().verify(selector)),
      restore: async (selector, dryRun, types, syncDeps, deploy, deployDelay) => unwrap(await ns().restore(selector, dryRun, types, syncDeps, deploy, deployDelay)),
      setAuto: async (hours) => unwrap(await ns().setAuto(hours)),
      githubStatus: async () => unwrap(await ns().githubStatus()),
      githubSyncNow: async () => unwrap(await ns().githubSyncNow()),
      githubPull: async () => unwrap(await ns().githubPull()),
      removeEntry: async (selector) => unwrap(await ns().removeEntry(selector)),
      setGithubRepo: async (repo) => unwrap(await ns().setGithubRepo(repo)),
    };
    // API 就绪：把面板交给「运维」区块（备份子页是唯一消费者）。
    panelHolder.current = panel;
    return () => {
      if (panelHolder.current === panel) panelHolder.current = undefined;
    };
  });
}
