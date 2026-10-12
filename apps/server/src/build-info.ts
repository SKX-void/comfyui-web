/**
 * 构建期打进去的版本指纹（宿主暴露给 /api/host，供"这份核心是哪个版本/哪个提交"追溯）。
 *
 * 打包态：`apps/server/scripts/build.mjs` 用 esbuild define 把这两个
 * `process.env.*` 表达式替换成真实值，运行时读到的就是常量；dev（tsx）态没有
 * define，回落到 'dev' —— 精确指纹以 `dist/manifest.json` 为准。
 */
const stampedVersion = process.env.COMFYUI_WEB_VERSION;
const stampedBuiltFrom = process.env.COMFYUI_WEB_BUILT_FROM;

export const VERSION = stampedVersion ?? 'dev';
export const BUILT_FROM = stampedBuiltFrom ?? 'dev';
