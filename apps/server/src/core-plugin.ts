import type { Context } from 'cordis';

import { registerAssetRoutes } from './core-assets.js';
import { createCoreHost, type CorePluginConfig } from './core-host.js';
import { registerCoreRoutes } from './core-routes.js';

/**
 * 宿主内置 core 插件：提供宿主级端点。
 *
 * 它不是 `/tabs` 里的插件，而是宿主自己 mount 的 cordis 插件 ——
 * 因为这几条路由是**宿主级**路径（`/api/plugins`、`/plugins/*`），
 * 不属于 `/api/p/<pluginId>` 的插件前缀约定。
 *
 * 端点：
 *   GET  /api/host                      宿主信息（数据目录 / tab 目录 / 契约版本）
 *   GET  /api/plugins                   tab 清单（真源 = /tabs 扫描 + 后端 Loader 状态）
 *   PUT  /api/plugins/:id/enabled       启停（写进 `data/host.json` 的 `disabled`，重启仍生效，D21）
 *   POST /api/tabs/rescan               重扫 /tabs 并增量装载（D20：唯一会改装载状态的入口）
 *   POST /api/tabs/:id/reload           强制重挂一个 tab（配置归插件自己，D15）
 *   GET  /api/ui                        外壳偏好 + 宿主全局设置（统一 ComfyUI 地址）
 *   PUT  /api/ui                        写这两样（<dataDir>/host.json 的偏好段）
 *   GET  /plugins/:id/*                 插件前端产物（从 tab 目录直送，不复制进 dist）
 *
 * 实现按"清单 / 路由 / 产物托管"分成三个文件，这里只做装配。
 */

export type { CorePluginConfig };
export { shortId } from './loader-entries.js';

export const name = 'host-core';

/** 需要 Loader 服务（清单的唯一真源就是它）；cordis 要求依赖必须显式声明 */
export const inject = ['loader'];

export function apply(ctx: Context, config: CorePluginConfig): void {
  const host = createCoreHost(ctx, config);
  registerCoreRoutes(host);
  registerAssetRoutes(host);
}
