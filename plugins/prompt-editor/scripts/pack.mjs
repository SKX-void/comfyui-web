#!/usr/bin/env node
/**
 * 打包成目录型 tab：产物写进 tabs/prompt-editor/（宿主真正加载的就是它）。
 *
 * 两步：① esbuild 把 server/ 那十来个模块打成**一个** server.js ——
 * 重挂时宿主只给入口说明符加 `?v=<token>`，多文件的话兄弟模块会命中 Node 的 ESM 缓存
 * （理由见 build-server.mjs）；② vite 打前端 client.js + client.css（vue 走页面 import map，必须 external）。
 */
import { fileURLToPath } from 'node:url';

import { packTab } from '../../../scripts/pack-tab.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');

await packTab({
  pluginDir,
  build: [
    ['node', ['scripts/build-server.mjs', ...(watch ? ['--watch'] : [])]],
    ['vite', ['build']],
  ],
  extras: ['README.md'],
  watch,
});
