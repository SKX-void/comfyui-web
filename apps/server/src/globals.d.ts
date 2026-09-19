/**
 * 打包期注入的常量（见 `scripts/build.mjs` 的 `define`）。
 *
 * - 打包产物（`node dist/server.mjs`）：esbuild 把它替换成 `true`
 * - 源码运行（`tsx src/index.ts`）：这个标识符在运行时并不存在，
 *   所以 **只能** 用 `typeof __BUNDLED__ !== 'undefined'` 判断，不能直接取值。
 *
 * 用途：config.ts 据此决定目录解析基准 ——
 * 打包态的"当前文件"就在 dist/ 里，源码态的"当前文件"在 apps/server/src/ 里，
 * 两者到仓库根的距离不一样。
 */
declare const __BUNDLED__: boolean;
