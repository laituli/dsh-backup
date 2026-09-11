#!/usr/bin/env node
/**
 * 发布推送（网络不稳时的刚性重试）：把 main 与指定 tag 推到 origin，直到成功。
 *
 * 背景：本机到 github.com:443 会整段不可达（`Failed to connect ... Timed out`），
 * 一次 `git push` 失败并不代表要放弃——按开发循环的刚性要求，git 动作必须完成。
 * 本脚本按固定间隔重试并在 stdout 打点，便于后台运行 + 事后核对。
 *
 * 用法: node scripts/push-with-retry.mjs [tag] [--attempts 40] [--interval 30]
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const tag = argv.find((a) => !a.startsWith('--')) || null;
const numOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const attempts = numOf('--attempts', 40);
const intervalSec = numOf('--interval', 30);

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
for (let i = 1; i <= attempts; i += 1) {
  const main = git(['push', '--quiet', 'origin', 'main']);
  if (!main.ok) {
    console.log(`[${stamp()}] 第 ${i} 次：main 推送失败 —— ${main.out.split('\n')[0]}`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    continue;
  }
  console.log(`[${stamp()}] 第 ${i} 次：main 推送成功`);
  if (!tag) { console.log('PUSH_ALL_OK'); process.exit(0); }
  const t = git(['push', '--quiet', 'origin', tag]);
  if (t.ok) { console.log(`[${stamp()}] tag ${tag} 推送成功`); console.log('PUSH_ALL_OK'); process.exit(0); }
  console.log(`[${stamp()}] 第 ${i} 次：tag 推送失败 —— ${t.out.split('\n')[0]}`);
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
console.log(`[${stamp()}] 重试 ${attempts} 次仍未成功（网络持续不可达）`);
process.exit(1);
