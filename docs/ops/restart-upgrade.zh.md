# 运维 · 重启 / 升级（正规路径）

## 四步（面板「运维 → 重启 / 升级」会给出成对可复制指令）

1. **重启前备份** —— 出问题可整包回滚；升级场景会与自动的 `dsh-pre-upgrade-*` 快照配成一对。
2. **停止旧宿主** —— `node <备份目录>/rescue.mjs stop --web-port <端口>`
3. **启动新宿主** —— 宿主自身启动命令（含 profile）；**执行它的窗口保持打开**，那就是宿主进程。
4. **重启后再备份一次** —— 关键一步：备份会把新版 `rescue.mjs` / `RESCUE.txt` / 启动器写进备份目录。
   冷启动救援用的就是这份快照，**不备份它不会自己更新**（Windows 上 `copyFile` 保留源文件时间，
   看内容/哈希，别看时间戳）。

## 平台注意

- **Windows / PowerShell**：以引号开头的可执行文件要用 `&` 调用（面板生成的指令已带 `&`）；
  cmd.exe 用户去掉行首的 `&` 即可。
- **自定义 DSH_HOME**：启动指令必须带同样的环境变量，否则新宿主会去读默认 `~/.dsh`。
  面板的「网络超时（秒）」旁边会提示是否检测到非默认环境。

## 升级 dsh 或插件

```bash
# 升级插件（git URL / npm / 本地 tarball 三选一）
dsh plugin --profile web add https://github.com/laituli/dsh-backup.git

# 升级 dsh 本体（按你的安装方式，npm 全局 / 包管理器）
npm i -g @deepseek-ai/dsh@latest
```

升级后跑四步；想验证「冷启动救援是否已换成新版」，看备份目录里 `rescue.mjs` 是否含 `stop` 子命令
（`node <备份目录>/rescue.mjs --help`）。
