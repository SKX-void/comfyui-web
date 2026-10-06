import path from 'node:path';
import type { Context } from 'cordis';
import type { FastifyInstance } from 'fastify';

import type { RescanResult, ScannedTab } from './tabs.js';

/**
 * core 端点用到的目录型 tab 注册表面。
 *
 * 只列端点真正用到的成员：core 不依赖 `TabsService` 的实现，只依赖这几个动作。
 */
export interface TabsFacade {
  /** **已装载**的 tab（row 的唯一来源）：没点重扫的目录不在里面 */
  scan(): ScannedTab[];
  /** 已装载的 tab + 它们当前的启用状态（清单要如实报 `enabled`） */
  rows(): Array<{ tab: ScannedTab; enabled: boolean }>;
  /** 单个 tab 现在的启用状态（启停端点回报用；与 `rows()` 同一判据） */
  enabledOf(id: string): boolean;
  /** 按 id 取一格 tab（拿入口路径与包元数据） */
  get(id: string): ScannedTab | undefined;
  rescan(): Promise<RescanResult>;
  owns(id: string): boolean;
  /** 重挂一个 tab：目录型插件自持配置，改完要重新 apply() 才生效（D15） */
  reload(id: string): Promise<boolean>;
}

export interface CorePluginConfig {
  app: FastifyInstance;
  /** tab 插件目录（目录型工作流插件；见 src/tabs.ts） */
  tabsDir: string;
  /** 目录型 tab 的注册表：清单、手动重扫、重挂 */
  tabs: TabsFacade;
  /** 数据目录：宿主配置与外壳偏好都在 `<dataDir>/host.json` */
  dataDir: string;
}

/** core 端点共享的上下文：配置 + 派生出来的宿主配置文件路径 */
export interface CoreHost {
  ctx: Context;
  app: FastifyInstance;
  config: CorePluginConfig;
  /** 宿主配置文件（部署段 + 运行期偏好同住一个文件，见 host-settings.ts） */
  settingsFile: string;
}

export function createCoreHost(ctx: Context, config: CorePluginConfig): CoreHost {
  return {
    ctx,
    app: config.app,
    config,
    settingsFile: path.join(config.dataDir, 'host.json'),
  };
}
