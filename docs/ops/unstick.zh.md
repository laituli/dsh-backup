# 命令卡一直显示「进行中」——悬挂命令的成因与封口

> 适用版本：宿主任意版本；`doctor --seal` 自 v0.11.13 起提供。
> 关键词：card stuck、command/run without command/done、无法调度 /compact、发消息没有反馈。

## 症状

- 聊天里某条命令卡（如 `/backup`）**永远显示「备份进行中」**，重启宿主也不消失。
- 同一会话里再发 `/compact` 或普通消息**没有反馈**：看起来发了，但什么也没发生。
- 其它会话（新开的对话）不受影响。

## 成因（已确证）

DSH 客户端把命令卡按 **`command/run` ↔ `command/done`** 一对记录折叠
（与 tool call ↔ tool result 同构）。宿主只在命令处理器**返回之后**才写 `command/done`。

于是当一条命令的处理器迟迟不返回——典型是它内联等待了一个**没有超时的网络动作**
（`git push` 在慢/断网时无限期挂着）——而宿主在这期间被强制结束（关窗口、任务管理器结束、
断电），日志里就只剩孤零零的 `command/run`：

```
{ "type": "command/run", "seq": 750393, "data": { "commandId": "cmd-527f5c32-1", "name": "backup" } }
（没有对应的 command/done）
```

客户端据此**永久**把它渲染成"正在执行"，宿主也不会自愈（内存状态不会因为日志变化而刷新）。
v0.11.4 及更早的 dsh-backup 正是这种写法：`/backup` 内联 `await githubSync()`，
而 `git push` 调用**没有传单次超时**——一次 GitHub 抖动就足以卡住整条命令。

## 处置（三步）

**必须先把 dsh 完全停掉**：运行中的宿主占着日志文件，而且它内存里仍是"在跑"的旧状态。

```powershell
# ① 停止宿主（结束占用 3080 的进程）
$p = (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if ($p) { Stop-Process -Id $p -Force }

# ② 先预览：哪些会话日志里有悬挂命令
node "$env:USERPROFILE\Desktop\dsh-backups\rescue.mjs" doctor --seal --dry-run

# ③ 真正封口（原日志会留档为 *.preseal-<时间戳>）
node "$env:USERPROFILE\Desktop\dsh-backups\rescue.mjs" doctor --seal

# ④ 重新启动宿主
dsh web
```

宿主还活着时也可以用聊天命令做同一件事（效果同样要重启后才可见）：

```
/backup doctor --seal --dry-run
/backup doctor --seal
```

封口做的是**追加**一帧记录，而不是重写整份日志——宿主读端要求首帧恰好一行
SessionHeader（`assertZstdHeaderFrame`），单帧重写会被整体拒载；追加帧天然满足契约，
`seq` 只要严格接续即可：

```json
{ "type": "command/done", "seq": 750394, "time": 1789093458905,
  "data": { "commandId": "cmd-527f5c32-1", "kind": "error",
            "text": "已中断：宿主在 /backup 执行期间被停止……" } }
```

重启后那张卡片会从「进行中」变成「已中断」，同会话的命令与消息恢复正常。
日志本身仍然是健康的（`/backup doctor` 复检为健康；封口是幂等的，重复执行不会重复追加）。

## 现场取证（可选）

定位"到底是哪条命令悬挂、什么时候挂的"时，`scripts/` 下有几个只读诊断脚本
（多帧 zstd 会话日志的解压/时间线/配对检查）：

```bash
node scripts/diag-session.mjs <会话目录>      # 记录类型分布 + 未配对调用 + 关键词命中
node scripts/diag-timeline.mjs <解压后的jsonl>  # 用户消息/轮次/命令生命周期时间线
node scripts/diag-events.mjs  <解压后的jsonl>  # 抽取 llm/retry、compaction、command 事件
```

`.jsonl.zstd` 是多帧拼接，Node 内置解码器只解第一帧；用 `zstd -d`（或
`tar --zstd`）先整份解压再喂给上面这些脚本。

## v0.11.13 起为什么不会再发生

1. **命令永不等待网络**：`/backup`、面板「立即备份/立即同步」、`backup_dsh` 工具一律
   **秒级结算**，GitHub 推送改成**后台任务**（进度与结论在 `status.sync`、
   `/backup github status` 可见，可 `/backup github cancel` 取消，也可
   `/backup github sync --wait` 显式等待）。
2. **命令出口有硬截止时间**：即便将来某一步（本地 tar、未来的新动作）真的卡死，
   `/backup` 也会在 180s（`commandDeadlineSec` / `DSH_BACKUP_CMD_DEADLINE_SEC` 可调）
   收敛为「已超时」并说明慢活仍在后台继续——命令卡**不可能**再悬挂。
3. **工作树全局串行**：后台同步任务、面板拉取、`--wait` 同步共用一把锁，
   并发引发的 `remote origin already exists`、ref 锁互抢同时消失。
4. **装配自检**：启动日志会打印 `装配 vX.Y.Z <加载路径>｜profile spec …`，
   内存里跑的版本与 profile 里写的 tag 不一致时**显式告警**——
   "界面是新版、宿主还是旧版"这类错配不再靠猜。
