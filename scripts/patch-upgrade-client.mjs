// 一次性补丁：把「前端内升级」的客户端半边接上（schema/端点/UI/文案）。
// 用法: node scripts/patch-upgrade-client.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const edit = (rel, pairs) => {
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to, tag] of pairs) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) { console.log(`❌ ${rel} / ${tag}: 锚点命中 ${hits} 次`); process.exitCode = 1; continue; }
    text = text.replace(from, to);
    console.log(`✅ ${rel} / ${tag}`);
  }
  fs.writeFileSync(file, text);
};

// ---------- client.js ----------
const statusUpgrade = `  // 前端内升级任务的阶段快照（null/缺省 = 无任务）
  upgrade: z.object({
    kind: z.string(),
    phase: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    backupName: z.string().nullable(),
    restartFile: z.string().nullable(),
    cancelRequested: z.boolean(),
    plugins: z.array(z.object({
      name: z.string(),
      profile: z.string(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      phase: z.string(),
      ok: z.boolean().nullable(),
      reason: z.string().nullable(),
      spec: z.string().optional(),
    })),
  }).nullable().optional(),
`;

const schemas = `const upgradePlanSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string().optional(),
  error: z.string().optional(),
  plugins: z.array(z.object({
    profile: z.string(),
    name: z.string(),
    spec: z.string(),
    repo: z.string().nullable(),
    current: z.string().nullable(),
    latest: z.string().nullable(),
    hasUpdate: z.boolean(),
    tagCount: z.number().int().optional(),
    reason: z.string().nullable(),
  })),
});

const upgradeRunSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  backupName: z.string().nullable().optional(),
  restartFile: z.string().nullable().optional(),
  plugins: z.array(z.object({
    name: z.string(),
    to: z.string().nullable(),
    phase: z.string(),
    ok: z.boolean().nullable(),
    reason: z.string().nullable(),
  })).optional(),
});

`;

const params = `const kindParam = { name: 'kind', wire: 'kind', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#kind', schema: z.string().optional() }, acceptsUndefined: true };
const upgradeNameParam = { name: 'name', wire: 'name', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-backup/types#upgradeName', schema: z.string().optional() }, acceptsUndefined: true };
`;

edit('src/client.js', [
  ['  restart: z.object({', statusUpgrade + '  restart: z.object({', 'status.upgrade'],
  ['const removeSchema = z.object({', schemas + 'const removeSchema = z.object({', 'schemas'],
  ['const keepParam = {', params + 'const keepParam = {', 'params'],
  ["    strictDescriptor('cancelSync', [], removeSchema, false),",
    "    strictDescriptor('cancelSync', [], removeSchema, false),\n"
    + "    strictDescriptor('upgradePlan', [], upgradePlanSchema, true),\n"
    + "    strictDescriptor('upgradeRun', [kindParam, upgradeNameParam], upgradeRunSchema, true),\n"
    + "    strictDescriptor('cancelUpgrade', [], removeSchema, false),", 'descriptors'],
  ['      cancelSync: async () => unwrap(await ns().cancelSync()),',
    "      cancelSync: async () => unwrap(await ns().cancelSync()),\n"
    + '      upgradePlan: async () => unwrap(await ns().upgradePlan()),\n'
    + '      upgradeRun: async (kind, name) => unwrap(await ns().upgradeRun(kind, name)),\n'
    + '      cancelUpgrade: async () => unwrap(await ns().cancelUpgrade()),', 'panel api'],
]);

// ---------- ops.jsx：UpgradeRunner 组件 + 挂进 UpgradeTab ----------
const runner = `/**
 * 前端内升级（个人 fork 用 url#tag 升级；市场按钮只跟 npm，跟不到 tag）：
 * 成对停机/启动指令置顶（升级前就能复制，因为升级后磁盘前端包变新、面板可能打不开），
 * 下面是 git 源插件清单与「升级 / 一键全部升级」，跑起来显示阶段进度并可取消。
 */
function UpgradeRunner({ panel, t, snap }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const job = snap !== null && snap !== undefined ? (snap.upgrade ?? null) : null;
  const restart = snap !== null && snap !== undefined ? snap.restart : null;
  const run = (id, fn) => {
    setBusy(id);
    setMsg('');
    void fn().then((r) => setMsg(r && r.summary ? r.summary : '')).catch((e) => setMsg(String(e && e.message ? e.message : e))).finally(() => setBusy(''));
  };
  const items = plan !== null && plan !== undefined ? (plan.plugins ?? []) : [];
  const updatable = items.filter((p) => p.hasUpdate);
  return (
    <div className="dsb-card">
      <h3 className="dsb-heading"><span>{t('upgTitle')}</span></h3>
      <p className="dsb-hint">{t('upgIntro')}</p>
      {restart !== null && restart !== undefined && (restart.portableStopCmd || restart.portableRelaunchCmd) ? (
        <CmdBlock
          t={t}
          title={t('upgRestartFirstTitle')}
          cmd={[restart.portableStopCmd, restart.portableRelaunchCmd].filter(Boolean).join('\\n')}
          hint={t('upgRestartFirstHint')}
        />
      ) : null}
      <div className="dsb-row">
        <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => run('plan', () => panel.upgradePlan().then((r) => { setPlan(r); return { summary: '' }; }))}>
          {busy === 'plan' ? t('upgChecking') : t('upgCheck')}
        </button>
        <button type="button" className="dsb-btn-secondary" disabled={busy !== '' || updatable.length === 0} onClick={() => run('all', () => panel.upgradeRun('all'))}>
          {busy === 'all' ? t('upgRunning') : t('upgAll')}
        </button>
        {job !== null && job.finishedAt === null ? (
          <button type="button" className="dsb-btn-secondary" onClick={() => run('cancel', () => panel.cancelUpgrade())}>
            {t('upgCancel')}
          </button>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul className="dsb-list">
          {items.map((p) => (
            <li key={p.name}>
              {p.name}
              {'：'}
              {p.current ?? '?'}
              {' → '}
              {p.latest ?? '?'}
              {p.hasUpdate ? (
                <button type="button" className="dsb-btn-secondary" disabled={busy !== ''} onClick={() => run('one:' + p.name, () => panel.upgradeRun('one', p.name))}>
                  {t('upgTo')}
                  {p.latest}
                </button>
              ) : (
                <span className="dsb-hint">{p.reason ? t('upgUnknown') + p.reason : t('upgLatest')}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {job !== null ? (
        <p className="dsb-hint" role="status">
          {t('upgPhase')}
          {job.phase}
          {'｜'}
          {job.plugins.map((x) => x.name + ':' + x.phase + (x.ok === false && x.reason ? '(' + x.reason + ')' : '')).join('；')}
        </p>
      ) : null}
      {msg !== '' ? <p className="dsb-banner" role="status">{msg}</p> : null}
    </div>
  );
}

`;
edit('src/ops.jsx', [
  ['export function UpgradeTab({ panel, t, onBackup }) {', runner + 'export function UpgradeTab({ panel, t, onBackup }) {', 'UpgradeRunner'],
  ["        <p className=\"dsb-hint\">{t('opsUpgradeIntro')}</p>", "        <p className=\"dsb-hint\">{t('opsUpgradeIntro')}</p>\n        <UpgradeRunner panel={panel} t={t} snap={snap} />", 'mount'],
]);

// ---------- locales ----------
const zh = `  upgTitle: '前端内升级已装插件',
  upgIntro: '个人 fork 的插件靠 url#tag 升级（市场那套按钮只跟 npm 版本，跟不到你的 tag）。按钮走四步事务：先备份 → 隔离 DSH_HOME 装配门（真起一次宿主）→ 通过才写入 profile → 提示「只差冷启动」。dsh 本体不走这里，仍按上面的升级顺序。',
  upgRestartFirstTitle: '先复制这对重启指令（升级后界面可能打不开）',
  upgRestartFirstHint: '升级会让磁盘上的前端包立刻变新、而内存里的宿主仍是旧版，刷新页面可能出错。所以这对指令在升级前就给你，并会同时落盘到备份根的 RESTART.txt。',
  upgCheck: '检查更新（读远端 tag）',
  upgChecking: '检查中…',
  upgAll: '一键全部升级',
  upgRunning: '执行中…',
  upgCancel: '取消本次升级',
  upgTo: '升级到 ',
  upgLatest: '已是最新',
  upgUnknown: '远端未知：',
  upgPhase: '阶段：',
`;
const en = `  upgTitle: 'Upgrade installed plugins from the panel',
  upgIntro: 'Personally forked plugins upgrade by url#tag (the market button only tracks npm versions, not your tags). The buttons run a four-step transaction: back up first → isolated DSH_HOME assembly gate (boots a real host) → only on success write the profile → then it tells you a cold restart is all that is left. The dsh package itself is not handled here.',
  upgRestartFirstTitle: 'Copy this restart pair first (the panel may not load after the upgrade)',
  upgRestartFirstHint: 'An upgrade makes the on-disk client bundle new while the in-memory host stays old, so refreshing can break. That is why the pair is shown before the upgrade and also written to RESTART.txt in the backup root.',
  upgCheck: 'Check for updates (remote tags)',
  upgChecking: 'Checking…',
  upgAll: 'Upgrade all',
  upgRunning: 'Running…',
  upgCancel: 'Cancel this upgrade',
  upgTo: 'Upgrade to ',
  upgLatest: 'up to date',
  upgUnknown: 'remote unknown: ',
  upgPhase: 'phase: ',
`;
edit('src/locales.js', [
  ["  netLabelFetch: '取回远端索引',", "  netLabelFetch: '取回远端索引',\n" + zh, 'zh'],
  ["  netLabelFetch: 'fetch remote index',", "  netLabelFetch: 'fetch remote index',\n" + en, 'en'],
]);

console.log(process.exitCode ? '有锚点未命中' : '补丁完成');
