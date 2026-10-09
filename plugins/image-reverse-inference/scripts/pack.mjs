#!/usr/bin/env node
/**
 * 打包成目录型 tab：产物写进 tabs/image-reverse-inference/（宿主真正加载的就是它）。
 *
 * ① esbuild 把 server/ 打成**一个** server.js（理由见 build-server.mjs）；
 * ② vite 打前端 client.js + client.css（vue 走页面 import map，必须 external）。
 * `workflow.json` 是运行期资产（`new URL('./workflow.json', import.meta.url)`），按名拷到 tab 根。
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
  extras: ['workflow.json'],
  watch,
});
