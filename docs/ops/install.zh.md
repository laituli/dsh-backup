# 运维 · 重装 / 安装插件（不动宿主数据）

> 与「恢复备份」严格区分：这里**只往 profile 里加插件**，不挪 `DSH_HOME`、不整包替换数据。
> 因此不需要停机窗口，也不做宿主机级验证——装完重启宿主让它加载即可。

## 1. 装/重装（三种来源）

```bash
# ① git URL（推荐：不依赖本机构建产物，灾时也能装）
dsh plugin --profile <profile> add https://github.com/laituli/dsh-backup.git

# ② npm 包（发布了才可用）
dsh plugin --profile <profile> add @xiaoyuyu6420/dsh-backup

# ③ 本地 tarball（改了自己的代码、想立刻用）
pnpm pack                       # 在插件仓库根执行，产出 *.tgz
dsh plugin --profile <profile> add <绝对路径>.tgz
```

## 2. 查看 / 移除

```bash
dsh plugin --profile <profile> list
dsh plugin --profile <profile> remove @xiaoyuyu6420/dsh-backup
```

## 3. 生效条件

- `dsh plugin add` 只改 profile 的依赖与锁文件；**宿主需重启**才会加载新插件代码。
- 客户端产物（面板 UI）随插件包一起发布；如果只替换了本机的 `lib/*.js`（开发态做法），
  浏览器还需 **Ctrl+F5 强刷**一次。

## 4. 与恢复的区别（一句话）

| | 安装/重装插件 | 恢复备份 |
|---|---|---|
| 动什么 | profile 的插件依赖 | 整个 `DSH_HOME` 数据 |
| 要停机吗 | 不用（重启加载即可） | 整包恢复需要；deploy 模式会自己停宿主 |
| 有回滚吗 | 重新装回旧版本即可 | 旧数据挪到 `.pre-restore-*` 可回滚 |
