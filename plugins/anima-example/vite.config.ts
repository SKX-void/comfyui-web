import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const clientSrc = fileURLToPath(new URL('./client/src', import.meta.url));

/**
 * 前端产物 = 一个自包含 ESM（`client.js`）+ 一个 CSS（`client.css`），落在 **tab 目录**
 * （`TAB_OUT_DIR`，由 scripts/pack.mjs 传入；单独跑 vite 时退回 `lib/`）。
 *
 * - `vue` / `vue-router` 必须 external：由宿主页面的 import map 提供
 *   （为什么必须是同一份 Vue：见 apps/web/src/main.ts 与 docs/architecture.md §7.1）；
 * - CSS 走 `client.css`，插件运行期用 `import.meta.url` 定位后以 <link> 注入。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': clientSrc },
  },
  build: {
    // tab 目录里还住着 pack.mjs 放好的 server.js / package.json，不能清空它
    outDir: process.env.TAB_OUT_DIR ?? 'lib',
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
        assetFileNames: 'client.[ext]',
      },
    },
  },
});
