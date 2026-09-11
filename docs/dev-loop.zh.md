# 开发-验证-发布循环（本插件的开发模式）

> 这份文档记录本项目采用的迭代流程与它背后的**硬规则**。规则不是审美偏好，
> 每一条都由一次真实事故换来（事故编号写在条目里）。

## 循环

```
① 开发        改 src/（面板）→ node scripts/build-client.mjs 重新打包 lib/client.js
              改 lib/index.js（宿主）→ 跑 node --check + 直接 import 冒烟
② 验证（门）  node scripts/verify-no-wedge.mjs     ← 命令/网络/日志三类悬挂面
              node scripts/smoke.mjs              ← 宿主面 240+ 断言（含面板服务、下载路由、GitHub 端到端）
              node scripts/smoke-client.mjs       ← 客户端面 28 断言（schema/槽位/SSR）
              node scripts/verify-upgrade-flow.mjs ← 真宿主 + 真 pnpm 的升级事务端到端
              node scripts/verify-release.mjs      ← 按 tag 内容装配 + 关键动作
③ 备份        /backup（发布前拍一份；升级前快照 dsh-pre-upgrade- 由宿主自动拍）
④ 重新部署    dsh plugin --profile <p> add "https://github.com/<owner>/dsh-backup.git#vX.Y.Z"
              改完依赖**必须冷启动**（宿主代码只在启动时装配一次）
⑤ 验证        重启后看启动日志的「装配 vX.Y.Z …」自检行 + 面板实际点一遍
⑥ 发布        git commit → git tag vX.Y.Z → git push（含 tag）→ 复核本地==远端
⑦ 重新部署    用 tag 再装一次，确认线上跑的就是 tag 内容（而不是工作区）
```

**门绿之前不发布、不贴部署指令**——两次把宿主跑挂（`property "x" without inject`、
`applyLlmRetryPolicy is not defined`）都是因为跳过了②。

## 硬规则（每条都对应一次事故）

1. **命令处理器必须结算**（2026-09-10 卡死事故）：DSH 按 `command/run`↔`command/done`
   折叠命令卡；处理器不返回 = 卡片永远「进行中」，同会话的 `/compact` 与聊天消息一起被挡。
   规则：**任何命令/工具/RPC 出口都要秒级结算**，慢活转后台任务；再加一层硬截止时间兜底
   （`withDeadline` + `commandDeadlineSec`）。
2. **网络动作永不内联等待**（同上）：`git push`/`fetch` 必须①有单次超时②在"刚性重试"窗口内
   有可见进度与取消③**放在后台任务里**，而不是命令的 `await` 里。历史上真的发生过
   "宿主被强杀后日志只剩 command/run"——修复工具见 `docs/ops/unstick.zh.md`。
3. **同一工作树的操作必须串行**（同日）：两路初始化同跑会出现
   `remote origin already exists`（实测），ref 锁互抢更糟。用一把进程内队列锁
   （`withWorktreeLock`）把同步/拉取/显式等待全串起来。
4. **子进程一律显式传 env**（升级事务）：`ctx.subprocess.spawn` 不接收 env，子进程继承宿主
   记录的环境——隔离验证里的 `pnpm add` 因此打到了**真实 profile**。改为直接
   `child_process.spawn` + 显式 `env`（钉死 `DSH_HOME`）与 `cwd`。
5. **装完必须回读效果**（升级事务）：`dsh plugin add` 返回 0 也可能什么都没装
   （实测假成功）。装完回读 profile spec，不含目标 tag 即判失败，并把命令输出带进原因。
6. **隔离验证要钉环境 + 防泄漏**：临时 `DSH_HOME`、临时备份目的地、临时裸仓库；
   绝不让测试碰到 `~/Desktop/dsh-backups` 与真实 GitHub 仓库。
7. **装配自检常驻**（版本错配）：启动打印加载路径、版本、profile spec、`panelOps` 方法探针；
   内存版本 ≠ profile spec 时告警——"界面是新版、宿主跑旧版"这类错配不再靠猜。
8. **失败要翻译成人话并给出路**（UX）：错误出口统一走 `friendlyReason`，文案=影响+出路
   （例："宿主可能仍持有该日志（先停止 dsh 再试）。原文件未改动"）。
9. **修复历史数据要可回退**：改会话日志/归档一律先留档（`*.preseal-*`、`*.corrupt-*`），
   并保持宿主读端契约（首帧恰好一行 header、`seq` 严格接续）。
10. **每次迭代把教训落到测试里**：本文件里每条规则都能在 `scripts/` 里找到对应的断言，
    否则下一个人（或下一个我）一定会再犯一次。
