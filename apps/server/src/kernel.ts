import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import { readHostSettings } from './host-settings.js';
import { SpaceService } from './handles/space.js';
import { RoutesService } from './handles/routes.js';
import { TabsService } from './tabs.js';
import { apply as applyCore, inject as coreInject, name as coreName, shortId } from './core-plugin.js';
import type { CorePluginConfig } from './core-plugin.js';

declare module 'cordis' {
  interface Context {
    space: SpaceService;
    routes: RoutesService;
  }
}

export interface BootOptions {
  app: FastifyInstance;
  dataDir: string;
  /** 目录型工作流插件（每个子目录一个，目录名即 id）；不存在就是没有 */
  tabsDir: string;
  logger: Logger;
}

export interface BootedHost {
  ctx: Context;
  space: SpaceService;
  /** 卸载整棵树（进程退出 / 测试收尾） */
  dispose: () => Promise<void>;
}

export async function bootHost(options: BootOptions): Promise<BootedHost> {
  const { app, dataDir, logger, tabsDir } = options;

  // 1. 句柄：先建出来，插件的 inject 才有东西可等。
  //    核只给**文件空间**：存储形态（SQLite / JSON / …）是插件自己的事。
  const space = new SpaceService(dataDir);
  const routes = new RoutesService(app);

  const ctx = new Context();
  // 裸包名的解析基准（plugin-package.ts 的 baseDir）：tab 目录自己就是包根。
  ctx.baseUrl = pathToFileURL(tabsDir).href + '/';
  await ctx.plugin(Loader);

  ctx.provide('space', space);
  ctx.provide('routes', routes);
  // 启动时向 fastify 注册唯一一条 /api/p/* 兜底路由：之后所有增删都是内存操作，
  // 因此运行期停用插件、就地重载配置都不受 fastify 路由表冻结的限制。
  routes.install();

  // 2. 目录型 tab 的注册表（`/tabs/<id>/`）——宿主**唯一**的插件来源（D16/D19）
  // 启停状态住在 data/host.json 的 disabled 列表里（宿主自己的状态，D21）：
  // core 端点写它，tabs 装载时读它。
  const settingsFile = path.join(dataDir, 'host.json');
  const tabs = new TabsService(ctx, tabsDir, logger, (id) => readHostSettings(settingsFile).disabled.includes(id));

  // 3. 宿主内置 core 插件（宿主级端点，不占插件前缀）
  const coreConfig: CorePluginConfig = { app, dataDir, tabsDir, tabs };
  ctx.plugin({ name: coreName, inject: [...coreInject], apply: applyCore }, coreConfig);

  // 4. 目录型 tab → Loader entries。宿主**不监听目录**（D20）：启动装一次，之后靠
  //    `POST /api/tabs/rescan`（设置页的「重新扫描」按钮）增量重挂变了的那几个。
  const scanned = await tabs.rescan();

  // 路由分发要靠"这一行现在是不是活的"来兜底：插件的路由表是内存里的，
  // 停用/卸载后不能再由它对外服务。
  // FiberState.ACTIVE === 2（const enum，不能跨包 import，这里用字面量 + 注释）。
  const FIBER_ACTIVE = 2;
  routes.setActivationResolver((pluginId) => {
    for (const entry of ctx.loader.entries()) {
      if (shortId(entry.id) !== pluginId) continue;
      if (entry.disabled) return 'disabled';
      if (entry.fiber === undefined) return 'inactive';
      return entry.fiber.state === FIBER_ACTIVE ? 'active' : 'inactive';
    }
    return 'unknown';
  });

  // 5. 装配审计：单插件失败隔离 —— 记录并继续，让设置页能把坏插件显示出来
  const broken: Array<{ id: string; reason: string }> = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.disabled) continue;
    if (entry.fiber === undefined) {
      broken.push({ id: entry.id, reason: '模块导入失败' });
      continue;
    }
    if (entry.fiber.state === 3) {
      let reason = '插件激活失败';
      try {
        await entry.fiber.await();
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      broken.push({ id: entry.id, reason });
    }
  }
  if (broken.length > 0) {
    logger.error({ broken }, '以下插件未成功装配（宿主继续运行，可在设置页查看）');
  }

  logger.info(
    {
      tabsDir,
      tabs: scanned.added.length + scanned.failed.length,
      plugins: [...ctx.loader.entries()].length,
    },
    '宿主内核已装配',
  );

  return {
    ctx,
    space,
    dispose: async () => {
      tabs.dispose();
      try {
        await ctx.fiber.dispose();
      } catch (err) {
        logger.warn({ err: String(err) }, '卸载插件树时出错');
      }
    },
  };
}
