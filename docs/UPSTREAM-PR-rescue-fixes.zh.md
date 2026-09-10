# 上游 PR 素材：rescue 通道的两处通用缺陷修复

来源：本 fork 在真实灾难演练与 E2E 中踩到，属上游 `rescue/rescue.mjs` 的通用问题（与 fork 特性无关）。

## 1. run() 在 spawn 级失败时掩盖真实错误

现象：`spawnSync` 因 ENOENT/EACCES/EPERM/maxBuffer 等原因失败时，`r.stdout`/`r.stderr` 为 `undefined`，
`Buffer.concat([r.stdout, r.stderr])` 直接抛
`TypeError: Cannot read properties of undefined (reading 'length')`，把真实原因顶掉——
灾时最需要看到的恰恰是那条原因（实测被它误导了两轮排查）。

最小修复：

```js
function run(argv, cwd) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${argv[0]} 无法执行: ${r.error.message}`);
  if (r.status !== 0) {
    const text = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)])
      .toString('utf8').slice(0, 800);
    throw new Error(`${argv[0]} ${argv.slice(1).join(' ')} 失败 (exit ${r.status}): ${text}`);
  }
  return (r.stdout ?? Buffer.alloc(0)).toString('utf8');
}
```

## 2. 备份目录位于数据目录内部时，整包恢复必然失败

现象：`restoreArchive` 先把整个 `DSH_HOME` rename 挪旁，而备份目录若在其内部，
归档路径与执行 cwd 随之失效（实测 `spawnSync tar ENOENT`），恢复走到一半失败再回滚。

最小修复（提前拦住并给人话指引）：

```js
if (root === dshHome || root.startsWith(`${dshHome}/`)) {
  throw new Error(`备份目录（${root}）位于数据目录（${dshHome}）内部：整包恢复会把它一起挪走，`
    + `归档随即不可读。请把备份 destination 指到数据目录之外（如 ~/Desktop/dsh-backups）。`);
}
```

## 复现

- 第 1 条：把 `tar` 从 PATH 摘掉（或指向不存在的路径）后执行 `rescue restore … --yes`；
- 第 2 条：把 `destination` 设为 `<DSH_HOME>/bkdest`，备份后执行 `rescue restore latest --yes`。

两处修复都已在本 fork 的 `scripts/e2e-restore-headless.mjs`（免 LLM、隔离 DSH_HOME）覆盖下验证通过。
