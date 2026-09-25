#!/usr/bin/env node
/**
 * 把构建好的插件（tabs/）搬进 dist/tabs，并确保 dist/data 存在 ——
 * 让 `pnpm build` 之后的 dist/ 是**完整可跑**的交付物：
 *
 *   dist/app/server.mjs   宿主（`node dist/app/server.mjs`，repoRoot 就是 dist/）
 *   dist/app/web/         前端外壳
 *   dist/tabs/<id>/       插件交付物（宿主唯一装载来源；插件前端也从这里直送）
 *   dist/data/            空目录，宿主首次启动在这里写 host.json（部署时的可写卷）
 *
 * 为什么是拷贝不是软链：dist/ 要能单独打包搬走，软链会指回仓库。
 * 为什么 hello/ 不进去：它是仓库里的手写示例（见 tabs/README.md），不是交付物。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcTabs = path.join(root, 'tabs');
const distDir = path.join(root, 'dist');
const distTabs = path.join(distDir, 'tabs');
const distData = path.join(distDir, 'data');
const EXCLUDE = new Set(['hello']);

if (!fs.existsSync(path.join(distDir, 'app', 'server.mjs'))) {
  console.error('[pack:dist] 找不到 dist/app/server.mjs：先跑 pnpm build:host');
  process.exit(1);
}

const ids = fs
  .readdirSync(srcTabs, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !EXCLUDE.has(e.name))
  .map((e) => e.name)
  .sort();

fs.rmSync(distTabs, { recursive: true, force: true });
fs.mkdirSync(distTabs, { recursive: true });
let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
};
for (const id of ids) {
  fs.cpSync(path.join(srcTabs, id), path.join(distTabs, id), { recursive: true });
  walk(path.join(distTabs, id));
}

// data/ 只保证存在，**绝不清理**：那里面是运行期状态（host.json + 插件空间）
fs.mkdirSync(distData, { recursive: true });

console.log(
  `[pack:dist] dist/tabs/ ← tabs/（${ids.length} 个插件：${ids.join(' ')}；${files} 个文件 ${(bytes / 1024).toFixed(0)} kB），dist/data/ 已就绪`,
);
