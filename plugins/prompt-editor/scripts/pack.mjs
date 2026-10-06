#!/usr/bin/env node
/**
 * 打包成目录型 tab：产物写进 tabs/prompt-editor/（宿主真正加载的就是它）。
 *
 * 服务端**不需要打包**：server.js 只 import node 内置模块和宿主句柄，拷过去就能装载。
 */
import { fileURLToPath } from 'node:url';

import { packTab } from '../../../scripts/pack-tab.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));

await packTab({
  pluginDir,
  build: [['vite', ['build']]],
  extras: ['server.js', 'README.md'],
  watch: process.argv.includes('--watch'),
});
