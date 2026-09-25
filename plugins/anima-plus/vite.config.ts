import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const clientSrc = fileURLToPath(new URL('./client/src', import.meta.url));

/**
 * 插件前端产物 = 一个自包含 ESM（`client.js`）+ 一个 CSS（`client.css`），落在 tab 目录（D16）。
 *
 * - `vue` / `vue-router` 必须 external：由宿主页面的 import map 提供
 *   （为什么必须是同一份 Vue：见 apps/web/src/main.ts 与 docs/architecture.md §7.1）；
 * - `@/` 别名指向本插件自己的 client/src，所以从 v1 复制过来的文件**一行 import 都不用改**；
 * - CSS 走 `client.css` 由插件在运行期用 `import.meta.url` 定位后以 <link> 注入，
 *   宿主不需要知道插件有几个产物文件。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': clientSrc },
  },
  build: {
    // 产物落进 tab 目录（TAB_OUT_DIR 由 scripts/pack.mjs 传入；单独跑 vite 时退回 lib/）
    outDir: process.env.TAB_OUT_DIR ?? 'lib',
    // 必须 false：tab 目录里还住着后端产物 server.js（build-server.mjs 先写的）和 package.json，
    // vite 默认会在构建前清空 outDir，会把它们删掉。前端产物名固定（client.js/client.css），
    // 不需要靠清空目录来避免残留哈希文件。
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./client/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: ['vue', 'vue-router'],
      output: {
        // 产物名固定，插件才能用 import.meta.url 拼出 CSS 地址
        assetFileNames: 'client.[ext]',
      },
    },
  },
});
