import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 后端端口**只从 data/host.json 读**，保证与后端永远一致（曾经踩过"两处各写一个端口"的坑）。
 * 文件不存在（空 data 卷 / 还没跑过宿主）就用内置默认 8087 —— 与宿主自己的回退一致。
 *
 * 例外：`COMFYUI_WEB_PORT` 可以临时覆盖 —— 排查时经常会出现"配置端口被别的实例占着，
 * 新实例只能起在别的端口"的情况（本仓就踩过），没有这个开关就只能去改配置文件。
 */
function readHostPort(): number {
  const override = Number(process.env.COMFYUI_WEB_PORT);
  if (Number.isInteger(override) && override > 0) return override;
  const dataDir = process.env.COMFYUI_WEB_DATA_DIR;
  const dir = dataDir !== undefined && dataDir.trim() !== '' ? dataDir : 'data';
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.resolve(repoRoot, dir, 'host.json'), 'utf8'),
    ) as { port?: number };
    return Number.isInteger(parsed.port) && (parsed.port as number) > 0 ? (parsed.port as number) : 8087;
  } catch {
    return 8087;
  }
}

const hostTarget = `http://127.0.0.1:${readHostPort()}`;

/**
 * 宿主与插件共享的运行时：保持**裸说明符**，交给浏览器 import map 解析 ——
 * 这正是"加插件不重编宿主"的核心机制。
 * 为什么必须是同一份 Vue：见 apps/web/src/main.ts 与 docs/architecture.md §7.1。
 */
const SHARED_RUNTIME = ['vue', 'vue-router'];

/** dev 态把共享运行时指向 public/vendor 里的文件（URL 必须与 import map 完全一致） */
const DEV_VENDOR: Record<string, string> = {
  vue: 'vue.esm-browser.js',
  // dev 版 router 会 import "@vue/devtools-api"（浏览器里没有裸说明符可解析 → 白屏）
  'vue-router': 'vue-router.esm-browser.prod.js',
};

function sharedRuntime(command: 'build' | 'serve'): Plugin {
  return {
    name: 'cw-shared-runtime',
    enforce: 'pre',
    resolveId(source) {
      if (!SHARED_RUNTIME.includes(source)) return null;
      if (command === 'serve') {
        // dev：Vite 会把裸说明符改写成 /@id/vue 并自己去解析 node_modules/vue，
        // 那就是第二份 Vue 实例。这里改成 import map 里的**同一个 URL**，
        // 于是宿主与插件拿到的是同一个模块实例。
        return { id: `/vendor/${DEV_VENDOR[source] as string}`, external: true };
      }
      // build：保留裸说明符，完全交给页面的 import map
      return { id: source, external: true };
    },
  };
}

/** index.html 里的共享运行时占位符：dev 用带警告版，构建用压缩版 */
function importMapVendor(mode: string): Plugin {
  const dev = mode !== 'production';
  return {
    name: 'cw-import-map-vendor',
    transformIndexHtml(html) {
      return html
        .replaceAll('__VUE__', dev ? 'vue.esm-browser.js' : 'vue.esm-browser.prod.js')
        // router 恒用 prod 版，理由见 scripts/vendor.mjs
        .replaceAll('__VUE_ROUTER__', 'vue-router.esm-browser.prod.js');
    },
  };
}

/**
 * dev 端口：**默认 5173**（本机外部入口 nginx 就固定指向它，例如 `5180 → 172.x.x.x:5173`），
 * 需要换端口用 `COMFYUI_WEB_DEV_PORT` 覆盖，不改文件。
 *
 * `server.strictPort: true`：端口被占就直接失败，不会自己漂到 5174 —— 否则外面那个
 * 固定入口会静默指空，表现为"前端打不开"而不是"端口被占"。
 */
function readWebPort(): number {
  const override = Number(process.env.COMFYUI_WEB_DEV_PORT);
  return Number.isInteger(override) && override > 0 ? override : 5173;
}

export default defineConfig(({ mode, command }) => ({
  plugins: [sharedRuntime(command), importMapVendor(mode), vue()],
  /**
   * dev 态下 `vue` 被解析成 `/vendor/vue.esm-browser.js`（= import map 里的同一个 URL）。
   * esbuild 预打包扫描器不认识这种"虚拟 URL"，会当成磁盘路径去 open，启动即报
   * `ENOENT: /vendor/vue.esm-browser.js`。
   *
   * 这两项合起来把扫描关掉：本仓唯一需要预打包的依赖就是共享运行时，而它们
   * **本来就不该被预打包**（必须是 import map 里那一份），所以没有损失。
   */
  optimizeDeps: {
    exclude: SHARED_RUNTIME,
    entries: [],
  },
  build: {
    // 产物统一在 dist/app/ 下（与 dist/tabs、dist/data 互不干扰）
    outDir: fileURLToPath(new URL('../../dist/app/web', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      // 构建期也要保持外部化，否则 import map 形同虚设
      external: SHARED_RUNTIME,
    },
  },
  server: {
    host: '0.0.0.0',
    port: readWebPort(),
    strictPort: true,
    /**
     * 外部 nginx 反代进来时 Host 头是网关的名字/端口，Vite 默认会以
     * "Blocked request. This host is not allowed." 拒绝 —— 表现是一片空白页。
     * dev 服务只在开发网络里，直接全放开。
     */
    allowedHosts: true,
    // /api 与 /plugins 都走代理：避免跨源（插件产物在宿主端口上）
    proxy: {
      '/api': { target: hostTarget, changeOrigin: true },
      '/plugins': { target: hostTarget, changeOrigin: true },
    },
  },
  preview: { host: '0.0.0.0', port: 4175 },
}));
