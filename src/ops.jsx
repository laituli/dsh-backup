/**
 * Settings「运维」区块：把备份/重启/升级三件事按场景拆成子页。
 *
 * 结构对齐内置 ui-settings-plugins 的区块契约：向 `settings.section` 注册
 * 一个区块（id `ops`），并声明 `children` 里的子页槽；区块组件负责渲染
 * tablist + `renderSlot('dsh-backup.ops.tab', {}, { only: id })`，各子页由
 * 本插件自己在这些槽里注册（备份页 = BackupTab）。
 *
 * 三个子页各自独立取数，互不阻塞：备份页挂了不影响重启页。
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots';
import { BackupTab } from './tab.jsx';
// 运维参考文档「同源引用」：git 侧 docs/ops/*.md 与 UI 渲染的是同一份文本
// （build-client 以 `.md` text loader 内联），不再各写一份差异化文案。
import { Markdown } from './md.jsx';
import migrateDoc from '../docs/ops/migrate.zh.md';
import installDoc from '../docs/ops/install.zh.md';
import restoreDoc from '../docs/ops/restore.zh.md';
import upgradeDoc from '../docs/ops/restart-upgrade.zh.md';

/** 本插件在「运维」区块里声明的子页槽。 */
export const OPS_TAB_SLOT = 'dsh-backup.ops.tab';
/** 需要订阅的槽：区块自己的子页槽，以及区块所在的出口。 */
const TAB_NAMES = [OPS_TAB_SLOT, 'settings.section'];

/** 状态请求超时（毫秒）：鉴权/连接异常时 RPC 会静默悬挂，必须有界。 */
const STATUS_TIMEOUT_MS = 15000;

/**
 * 子页清单（已注册条目的 id/order/label），随槽账本与语言变化刷新。
 * 与内置 ui-settings-plugins 的 useTabs 同构：版本号变化才重建数组，
 * getSnapshot 才能保持引用稳定。
 * @param ctx 客户端根上下文（提供 slots / locale）。
 * @returns 每次渲染返回同一份快照，直到账本或语言真的变了。
 */
let tabCache = { version: -1, revision: -1, rows: [] };

/** 槽账本版本：服务未暴露 getVersion 时退化为 0（不缓存刷新）。 */
function ledgerVersion(ctx) {
  try {
    return typeof ctx.slots.getVersion === 'function' ? ctx.slots.getVersion(OPS_TAB_SLOT) : 0;
  } catch { return 0; }
}

/**
 * 构建子页清单快照（带缓存，引用稳定）。
 * @param ctx 客户端根上下文。
 * @returns {{id: string, order: number, label: string}[]} 按 order 升序。
 */
function buildTabs(ctx) {
  const version = ledgerVersion(ctx);
  const revision = typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot().revision : 0;
  if (version === tabCache.version && revision === tabCache.revision) return tabCache.rows;
  const rows = ctx.slots.entries(OPS_TAB_SLOT).map((entry) => ({
    id: entry.options.id ?? '',
    order: entry.options.order ?? 0,
    label: resolveSlotLabel(entry.options.label) ?? '',
  })).sort((a, b) => a.order - b.order);
  tabCache = { version, revision, rows };
  return rows;
}

export function useOpsTabs(ctx) {
  return useSyncExternalStore(
    (listener) => {
      const offLedger = ctx.slots.subscribe(TAB_NAMES, listener);
      const offLocale = ctx.locale.subscribe(listener);
      return () => { offLedger(); offLocale(); };
    },
    () => buildTabs(ctx),
  );
}

/**
 * 给一个可能永不落定的 Promise 加有界等待。
 * @param promise 待等待的 Promise。
 * @param t 文案函数。
 * @returns 原结果；超时则 reject 一条人话错误。
 */
function withTimeout(promise, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(t('statusTimeout')));
    }, STATUS_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 一条可复制指令块（与 tab.jsx 内的 CmdBlock 同形，供独立子页复用）。 */
function CmdBlock({ t, title, cmd, hint }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const s = String(cmd ?? '');
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch { /* 复制失败不阻塞 */ }
      done();
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        void navigator.clipboard.writeText(s).then(done).catch(fallback);
        return;
      }
    } catch { /* 走回退 */ }
    fallback();
  };
  return (
    <div className="dsb-cmd">
      <div className="dsb-cmd-head">
        <span className="dsb-cmd-title">{title}</span>
        <button type="button" className="dsb-btn-secondary dsb-copy" onClick={copy} aria-label={title}>
          {copied ? t('cmdCopied') : t('cmdCopy')}
        </button>
      </div>
      {hint ? <p className="dsb-hint">{hint}</p> : null}
      <pre className="dsb-cmd-pre">{cmd}</pre>
    </div>
  );
}

/**
 * 子页共用的状态取数：各自有界等待，避免鉴权/连接异常时永久转圈。
 * @param panel 注入的 backupPanel API（可能尚未就绪）。
 * @param t 文案函数。
 * @returns {{snap: any, failed: boolean, retry: () => void}}
 */
function useStatus(panel, t) {
  const [snap, setSnap] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    if (panel === undefined || panel === null) {
      setFailed(true);
      return () => { current = false; };
    }
    void withTimeout(panel.status(), t).then(
      (snapshot) => { if (current) setSnap(snapshot); },
      () => { if (current) { setFailed(true); setSnap(null); } },
    );
    return () => { current = false; };
  }, [panel, t, attempt]);
  const retry = useCallback(() => { setAttempt((n) => n + 1); }, []);
  return { snap, failed, retry };
}

/** 取数失败时的统一提示（含重试）。 */
function StatusNotice({ t, failed, onRetry, hint }) {
  if (!failed) return null;
  return (
    <div className="dsb-card">
      <p className="dsb-status">{t('error')}</p>
      {hint ? <p className="dsb-hint">{hint}</p> : null}
      <div className="dsb-row">
        <button type="button" className="dsb-btn-secondary" onClick={onRetry}>{t('retry')}</button>
      </div>
    </div>
  );
}

/** 「重启」子页：停机并启动一条多行指令 + 重启前后各备份一次。 */
export function RestartTab({ panel, t, onBackup }) {
  const { snap, failed, retry } = useStatus(panel, t);
  const restart = snap?.restart;
  return (
    <div className="dsb-ops-page">
      <h4 className="dsb-heading">{t('opsRestartTitle')}</h4>
      <p className="dsb-hint">{t('opsRestartIntro')}</p>

      <StatusNotice t={t} failed={failed} onRetry={retry} hint={t('opsStatusHint')} />

      {restart ? (
        <div className="dsb-card dsb-handoff">
          <h3 className="dsb-heading">
            <span>{t('restartCardTitle')}</span>
            <span className="dsb-badge">{`port ${restart.webPort}`}</span>
          </h3>
          <p className="dsb-hint">{t('restartCardHint')}</p>
          <div className="dsb-row" style={{ marginTop: '6px' }}>
            <button type="button" className="dsb-btn-secondary" onClick={onBackup}>
              {t('restartBackupBefore')}
            </button>
          </div>
          <p className="dsb-hint">{t('restartBackupBeforeHint')}</p>
          <CmdBlock
            t={t}
            title={t('stopStartCombinedTitle')}
            cmd={[restart.stopCmd, restart.relaunchCmd].join('\n')}
            hint={t('stopStartCombinedHint')}
          />
          <div className="dsb-row" style={{ marginTop: '2px' }}>
            <button type="button" className="dsb-btn-secondary" onClick={onBackup}>
              {t('restartBackupAfter')}
            </button>
          </div>
          <p className="dsb-hint">{t('restartBackupAfterHint')}</p>
        </div>
      ) : null}

      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsReopenTitle')}</span></h3>
        <p className="dsb-hint">{t('opsReopenHint')}</p>
      </div>
    </div>
  );
}

/** 「升级」子页：升级前快照 → 更新 → 重启 → 重启后再备份刷新救援快照。 */
export function UpgradeTab({ panel, t, onBackup }) {
  const { snap, failed, retry } = useStatus(panel, t);
  const restart = snap?.restart;
  return (
    <div className="dsb-ops-page">
      <h4 className="dsb-heading">{t('opsUpgradeTitle')}</h4>
      <p className="dsb-hint">{t('opsUpgradeIntro')}</p>

      <StatusNotice t={t} failed={failed} onRetry={retry} hint={t('opsStatusHint')} />

      <div className="dsb-card dsb-handoff">
        <h3 className="dsb-heading"><span>{t('opsUpgradeStepsTitle')}</span></h3>
        <ol className="dsb-ops-steps">
          <li>{t('opsUpgradeStep1')}</li>
          <li>{t('opsUpgradeStep2')}</li>
          <li>{t('opsUpgradeStep3')}</li>
          <li>{t('opsUpgradeStep4')}</li>
        </ol>
        <div className="dsb-row">
          <button type="button" className="dsb-btn-secondary" onClick={onBackup}>
            {t('restartBackupBefore')}
          </button>
          <button type="button" className="dsb-btn-secondary" onClick={onBackup}>
            {t('restartBackupAfter')}
          </button>
        </div>
        <p className="dsb-hint">{t('restartBackupAfterHint')}</p>
        {restart ? (
          <CmdBlock
            t={t}
            title={t('stopStartCombinedTitle')}
            cmd={[restart.stopCmd, restart.relaunchCmd].join('\n')}
            hint={t('stopStartCombinedHint')}
          />
        ) : null}
      </div>

      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsUpgradeSyncTitle')}</span></h3>
        <p className="dsb-hint">{t('opsUpgradeSyncHint')}</p>
      </div>

      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsDocsTitle')}</span></h3>
        <Markdown text={upgradeDoc} t={t} />
      </div>
    </div>
  );
}

/**
 * 迁移子页：跨机迁移向导（git URL 形态）+ 同源参考文档。
 * 面板只负责「给出可复制指令 + 展示 git 侧那份文档」，流程本身不依赖本机绝对路径。
 */
export function MigrateTab({ t }) {
  return (
    <div className="dsb-ops-page">
      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsMigrateTitle')}</span></h3>
        <p className="dsb-hint">{t('opsMigrateIntro')}</p>
        <CmdBlock
          t={t}
          title={t('opsMigrateCloneTitle')}
          cmd={'git clone <数据仓 https URL>\ncd <仓库目录>\nls dsh-*.tar.gz dsh-*.tar.gz.sha256'}
          hint={t('opsMigrateCloneHint')}
        />
        <CmdBlock
          t={t}
          title={t('opsMigrateToolTitle')}
          cmd={'git clone https://github.com/laituli/dsh-backup.git\nnode dsh-backup/rescue/rescue.mjs --help'}
          hint={t('opsMigrateToolHint')}
        />
        <CmdBlock
          t={t}
          title={t('opsMigrateRestoreTitle')}
          cmd={'node <救援脚本> stop --web-port <端口>\nnode <救援脚本> verify all --root <数据仓目录>\nnode <救援脚本> restore latest --yes --root <数据仓目录>'}
          hint={t('opsMigrateRestoreHint')}
        />
      </div>
      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsDocsTitle')}</span></h3>
        <p className="dsb-hint">{t('opsDocsHint')}</p>
        <Markdown text={migrateDoc} t={t} />
      </div>
      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsRestoreDocTitle')}</span></h3>
        <Markdown text={restoreDoc} t={t} />
      </div>
    </div>
  );
}

/**
 * 重装/安装子页：只往 profile 里加插件，不碰宿主数据（与恢复备份严格区分）。
 * 因此不需要停机窗口，也不做宿主机级验证——装完重启宿主加载即可。
 */
export function InstallTab({ panel, t }) {
  const { snap } = useStatus(panel, t);
  const plan = snap?.installPlan;
  const installCmds = (() => {
    if (!plan) return null;
    const lines = [`npm i -g @deepseek-ai/dsh@${plan.dshVersion ?? 'latest'}`];
    for (const p of plan.profiles) {
      for (const dep of p.deps) lines.push(`dsh plugin --profile ${p.name} add "${dep.ref}"`);
    }
    return lines.join('\n');
  })();
  return (
    <div className="dsb-ops-page">
      {installCmds ? (
        <div className="dsb-card">
          <h3 className="dsb-heading"><span>{t('opsInstallPlanTitle')}</span></h3>
          <p className="dsb-hint">{t('opsInstallPlanHint')}</p>
          <CmdBlock t={t} title={t('opsInstallPlanCmdTitle')} cmd={installCmds} hint={t('opsInstallPlanCmdHint')} />
        </div>
      ) : null}
      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsInstallTitle')}</span></h3>
        <p className="dsb-hint">{t('opsInstallIntro')}</p>
        <CmdBlock
          t={t}
          title={t('opsInstallGitTitle')}
          cmd={'dsh plugin --profile <profile> add https://github.com/laituli/dsh-backup.git'}
          hint={t('opsInstallGitHint')}
        />
        <CmdBlock
          t={t}
          title={t('opsInstallTarballTitle')}
          cmd={'pnpm pack\ndsh plugin --profile <profile> add <绝对路径>.tgz'}
          hint={t('opsInstallTarballHint')}
        />
        <CmdBlock
          t={t}
          title={t('opsInstallListTitle')}
          cmd={'dsh plugin --profile <profile> list\ndsh plugin --profile <profile> remove @xiaoyuyu6420/dsh-backup'}
          hint={t('opsInstallListHint')}
        />
      </div>
      <div className="dsb-card">
        <h3 className="dsb-heading"><span>{t('opsDocsTitle')}</span></h3>
        <Markdown text={installDoc} t={t} />
      </div>
    </div>
  );
}

/**
 * 渲染「运维」区块：子页导航 + 当前子页内容。
 * @param props.t 文案函数；props.renderSlot 槽渲染器；props.ctx 客户端根上下文。
 */
export function OpsSection({ t, renderSlot, ctx, panel }) {
  const tabsId = useId();
  const tabRefs = useRef([]);
  const rows = useOpsTabs(ctx);
  const [activeId, setActiveId] = useState();
  const [visitedIds, setVisitedIds] = useState(() => new Set());
  const active = rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id;

  useEffect(() => {
    if (active === undefined) return;
    setVisitedIds((previous) => (previous.has(active) ? previous : new Set([...previous, active])));
  }, [active]);

  /** 备份动作由区块统一提供，三个子页共用同一份实现。 */
  const runBackup = useCallback(() => {
    if (panel === undefined || panel === null) return;
    void panel.backup().catch(() => { /* 结果由备份页横幅呈现 */ });
  }, [panel]);

  const childProps = { t, panel, onBackup: runBackup };

  if (rows.length === 0) {
    return (
      <div className="dsb-ops-section" data-dsh-backup="">
        <h2 className="dsb-ops-heading">{t('opsNav')}</h2>
        <p className="dsb-ops-intro">{t('opsIntro')}</p>
        <p className="dsb-status">{t('opsEmpty')}</p>
      </div>
    );
  }

  return (
    <div className="dsb-ops-section" data-dsh-backup="">
      <h2 className="dsb-ops-heading">{t('opsNav')}</h2>
      <p className="dsb-ops-intro">{t('opsIntro')}</p>
      <div className="dsb-ops-tabs" role="tablist" aria-label={t('opsTabs')}>
        {rows.map((row, index) => {
          const selected = row.id === active;
          return (
            <button
              key={row.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={`${tabsId}-tab-${row.id}`}
              type="button"
              role="tab"
              className="dsb-ops-tab"
              aria-selected={selected}
              aria-controls={`${tabsId}-panel-${row.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(row.id)}
              onKeyDown={(event) => {
                let nextIndex;
                switch (event.key) {
                  case 'ArrowRight': nextIndex = (index + 1) % rows.length; break;
                  case 'ArrowLeft': nextIndex = (index - 1 + rows.length) % rows.length; break;
                  case 'Home': nextIndex = 0; break;
                  case 'End': nextIndex = rows.length - 1; break;
                  default: return;
                }
                event.preventDefault();
                setActiveId(rows[nextIndex].id);
                tabRefs.current[nextIndex]?.focus();
              }}
            >
              {row.label}
            </button>
          );
        })}
      </div>
      {rows.filter((row) => row.id === active || visitedIds.has(row.id)).map((row) => {
        const selected = row.id === active;
        return (
          <div
            key={row.id}
            id={`${tabsId}-panel-${row.id}`}
            className="dsb-ops-panel"
            role="tabpanel"
            aria-labelledby={`${tabsId}-tab-${row.id}`}
            hidden={!selected}
          >
            {row.id === 'ops-backup' ? (
              renderSlot(OPS_TAB_SLOT, childProps, { only: row.id })
            ) : row.id === 'ops-restart' ? (
              <RestartTab {...childProps} />
            ) : row.id === 'ops-upgrade' ? (
              <UpgradeTab {...childProps} />
            ) : row.id === 'ops-migrate' ? (
              <MigrateTab {...childProps} />
            ) : (
              <InstallTab {...childProps} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 备份子页：复用既有 BackupTab（自身取数、自渲染错误）。 */
export function OpsBackupTab({ panel, t }) {
  return <BackupTab panel={panel} t={t} />;
}
