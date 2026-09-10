# 运维 · 跨机迁移向导（git URL 形态）

> 目标：把一台机器上的 DSH 数据搬到另一台机器（或重装系统后搬回），全程只用 git URL 与一条命令行，
> 灾时不需要 GUI、不需要插件已安装。

## 0. 两条硬前提（先看这个，否则会白忙）

1. **DSH_HOME 必须与归档同名目录（basename）一致。** 默认都是 `~/.dsh` → 天然一致；
   若你用过自定义 DSH_HOME（如 `D:/dshdata`），目标机必须也用同一个**末级目录名**，
   否则恢复会被前置校验直接拒绝：`归档包含不安全条目（拒绝恢复）`。
2. **迁移后启动宿主的命令必须带上同样的 DSH_HOME 与工作目录（cwd）。**
   宿主每次启动重新解析 DSH_HOME；丢了它就会去读 `~/.dsh`，看起来像“恢复完什么都没了”。

## 1. 取数据（git URL）

```bash
git clone <数据仓 https URL>            # 例: https://github.com/<你>/dsh-backup-data.git
cd <仓库目录>
ls dsh-*.tar.gz dsh-*.tar.gz.sha256    # 归档与校验边车都在仓库根
```

## 2. 取救援工具（两种，任选）

- 插件已装：直接用插件自带的救援脚本（路径见面板「运维 → 迁移」页给出的可复制指令）。
- 插件没装 / profile 坏了：从仓库取——救援脚本随插件包发布：

```bash
git clone https://github.com/laituli/dsh-backup.git
node dsh-backup/rescue/rescue.mjs --help
```

## 3. 恢复（数据目录在跑就别用这条，见「恢复」文档）

```bash
# 先停宿主（面板「运维 → 重启」给出的 stop 指令，或 ops.mjs stop）
node <运维脚本 ops.mjs> stop --web-port <端口>

# 校验 + 恢复（--yes 才真正写入；不带 --yes 只是预览）
node <救援脚本> verify all --root <数据仓目录>
node <救援脚本> restore latest --yes --root <数据仓目录>
```

恢复会先把当前 `DSH_HOME` 挪到 `<同名>.pre-restore-<时间>`（不删除），再写入归档内容。

## 4. 收尾（缺一步都会“起不来”或“像丢了数据”）

1. **重装 profile 依赖**（node_modules 不进归档）：进各 profile 目录跑 `pnpm install`，或用面板恢复时的
   「同时重装插件依赖」。顺序必须是**先装依赖、再启动**。
2. **会话日志体检**：`node <救援脚本> doctor` 期望 `corruptCount=0`；有损坏用
   `doctor --repair <归档>` 定点修复（它只认当前 DSH_HOME/sessions）。
3. **启动宿主**：用面板给出的启动指令（含 profile 与 DSH_HOME/cwd）。
4. **抽查**：侧边栏能看到历史会话；打开其中一条确认内容完整。

## 5. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `归档包含不安全条目（拒绝恢复）` | 归档 basename ≠ 当前 DSH_HOME basename | 让目标机 DSH_HOME 末级目录名与归档一致；或改用分类型 merge 恢复 |
| 恢复成功但启动后看不到数据 | 启动命令丢了 DSH_HOME / cwd | 用带 env 的启动指令；确认 `DSH_HOME` 指向恢复出来的目录 |
| 会话能列出但打不开 | 会话日志损坏 | `doctor` → `doctor --repair <归档>` |
| 绝对路径报错（settings / cordis） | 归档来自另一台机器/用户目录 | 按恢复后的 ⚠️ 提示逐项修正 `settings.yaml`、`cordis*.yml`、`storages/workspace.json` |
| 插件装不上/起不来 | profile 依赖缺失 | 进 profile 目录 `pnpm install`，再启动 |
