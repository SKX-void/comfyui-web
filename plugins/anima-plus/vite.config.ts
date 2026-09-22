import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const clientSrc = fileURLToPath(new URL('./client/src', import.meta.url));

/**
 * 插件前端产物 = 一个自包含 ESM（`lib/client.js`）+ 一个 CSS（`lib/client.css`）。
 *
 * - `vue` / `vue-router` 必须 external：由宿主页面的 import map 提供**同一份**实例；
 * - `@/` 别名指向本插件自己的 client/src，所以从 v1 复制过来的文件**一行 import 都不用改**；
 * - CSS 走 `lib/client.css` 由插件在运行期用 `import.meta.url` 定位后以 <link> 注入，
 *   宿主不需要知道插件有几个产物文件。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': clientSrc },
  },
  build: {
    outDir: 'lib',
    // 必须 false：`lib/` 里还住着后端产物 `lib/server.js`（scripts/build-server.mjs 写的），
    // vite 默认会在构建前清空 outDir —— 它会把刚打好的后端产物删掉，宿主随即报
    // "Cannot find module .../lib/server.js"。前端产物名固定（client.js/client.css），
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
