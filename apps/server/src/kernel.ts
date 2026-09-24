import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import Include from '@cordisjs/plugin-include';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import { SpaceService } from './handles/space.js';
import { RoutesService } from './handles/routes.js';
import { resolvePluginPackage, SUPPORTED_CONTRACT } from './plugin-package.js';
import { TabsService } from './tabs.js';
import { apply as applyCore, inject as coreInject, isPluginEntry, name as coreName, shortId } from './core-plugin.js';
import type { CorePluginConfig } from './core-plugin.js';

declare module 'cordis' {
  interface Context {
    space: SpaceService;
    routes: RoutesService;
  }
}

export interface BootOptions {
  app: FastifyInstance;
  profile: string;
  profileDir: string;
  manifestFile: string;
  dataDir: string;
  /** 目录型工作流插件（每个子目录一个，目录名即 id）；不存在就是没有 */
  tabsDir: string;
  logger: Logger;
}

export interface BootedHost {
  ctx: Context;
  space: SpaceService;
  /** 契约闸门拦下的行（行 id → 原因）：这些行压根没被挂进树里 */
  gate: Map<string, string>;
  /** 卸载整棵树（进程退出 / 测试收尾） */
  dispose: () => Promise<void>;
}

/**
 * 读一遍清单文件（plugins.yml）。读不出来就当成"没有插件"：
 * 树的挂载由 Loader 自己再做一次，报错是那一侧的事。
 */
function readManifestRows(manifestFile: string, logger: Logger): unknown[] {
  if (!fs.existsSync(manifestFile)) return [];
  try {
    const rows = yaml.load(fs.readFileSync(manifestFile, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'plugins.yml 解析失败（树挂载时会再次报错）',
    );
    return [];
  }
}

/** 清单行 → (id, 模块说明符, config)；形状不对的行返回 undefined */
function rowIdentity(
  row: unknown,
): { id: string; specifier: string; config: unknown } | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const specifier = typeof record.name === 'string' ? record.name : undefined;
  if (id === undefined || specifier === undefined) return undefined;
  return { id, specifier, config: record.config };
}

/**
 * 契约闸门：在树挂载**之前**读一遍 plugins.yml，把"宿主不认识的契约版本"的行
 * 用 patch 层禁掉 —— 文件本身不动，插件也不会被导入（docs/architecture.md §4.5）。
 */
function computeGate(
  rows: unknown[],
  profileDir: string,
): { patches: Array<Record<string, unknown>>; gate: Map<string, string> } {
  const gate = new Map<string, string>();
  const patches: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const identity = rowIdentity(row);
    if (identity === undefined) continue;

    const pkg = resolvePluginPackage(identity.specifier, profileDir);
    if (!pkg) {
      gate.set(identity.id, `无法解析插件包 "${identity.specifier}"（profile 里装了吗？）`);
      patches.push({ id: identity.id, disabled: true });
      continue;
    }
    const contract = pkg.manifest.contract;
    if (contract !== undefined && contract !== SUPPORTED_CONTRACT) {
      gate.set(
        identity.id,
        `契约版本不符：插件声明 contract=${String(contract)}，宿主支持 ${SUPPORTED_CONTRACT}`,
      );
      patches.push({ id: identity.id, disabled: true });
    }
  }

  return { patches, gate };
}

/** 文件里的原始配置（行 id → config）；**每次现读**，不缓存 */
function makeRawConfigReader(
  manifestFile: string,
  logger: Logger,
): () => Map<string, Record<string, unknown>> {
  return () => {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of readManifestRows(manifestFile, logger)) {
      const identity = rowIdentity(row);
      if (identity === undefined) continue;
      const raw = identity.config;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        map.set(identity.id, raw as Record<string, unknown>);
      }
    }
    return map;
  };
}

export async function bootHost(options: BootOptions): Promise<BootedHost> {
  const { app, profileDir, manifestFile, dataDir, logger, tabsDir } = options;

  // 1. 句柄：先建出来，插件的 inject 才有东西可等。
  //    核只给**文件空间**：存储形态（SQLite / JSON / …）是插件自己的事。
  const space = new SpaceService(dataDir);
  const routes = new RoutesService(app);

  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(profileDir).href + '/';
  await ctx.plugin(Loader);

  ctx.provide('space', space);
  ctx.provide('routes', routes);
  // 启动时向 fastify 注册唯一一条 /api/p/* 兜底路由：之后所有增删都是内存操作，
  // 因此运行期停用插件、就地重载配置都不受 fastify 路由表冻结的限制。
  routes.install();

  // 2. 清单 → 契约闸门 + 全局兜底（两件事都走 patch 层，都不改文件）
  const rows = readManifestRows(manifestFile, logger);
  const { patches: gatePatches, gate } = computeGate(rows, profileDir);
  if (gate.size > 0) {
    logger.warn({ rejected: [...gate.keys()] }, '有插件未通过契约闸门，已拒绝加载');
  }
  // 统一 ComfyUI 地址这类"宿主全局设置"的注入不在这里做：内核只负责把树挂起来，
  // core 插件启动时按 ui-prefs.json 的跟随名单把值写进对应插件的行配置（见 §5.7）。
  const patches = gatePatches;

  // 3. 目录型 tab 的注册表（`/tabs/<id>/`，目录名即 id）。
  //    它和 profile 是**同一个 manifest 契约的两个来源**：契约闸门、失败隔离、
  //    清单端点、前端 tab 装载全部复用，所以先建出来交给 core。
  const tabs = new TabsService(ctx, tabsDir, logger, gate);

  // 4. 宿主内置 core 插件（宿主级端点，不占插件前缀）
  const coreConfig: CorePluginConfig = {
    app,
    profile: options.profile,
    profileDir,
    manifestFile,
    dataDir,
    tabsDir,
    tabs,
    resolvePackage: (specifier) => resolvePluginPackage(specifier, profileDir),
    gate,
    readRawConfigs: makeRawConfigReader(manifestFile, logger),
  };
  ctx.plugin({ name: coreName, inject: [...coreInject], apply: applyCore }, coreConfig);

  // 5. 树：Include 作为 Loader 的一个 entry 挂载（不是当插件挂）。
  //    create 自己分配 entry id，文件里的行 id 只用于 patch 定位；
  //    子行的 id 形如 `<includeId>:<行 id>`。
  //    清单不存在就整段跳过：只放 `/tabs` 的部署不该被"必须先有 profile"挡住。
  if (fs.existsSync(manifestFile)) {
    ctx.loader.builtins.include = Include;
    await ctx.loader.create({
      name: 'cordis:include',
      config: {
        path: pathToFileURL(manifestFile).href,
        ...(patches.length > 0 ? { patches } : {}),
      },
    });
    await ctx.loader.await();
  } else {
    logger.info({ manifestFile }, '没有 profile 清单：这次只加载 /tabs 目录型插件');
  }

  // 6. 目录型 tab → Loader entries。之后目录增删由 fs.watch 触发重扫（热挂/热卸），
  //    改插件**代码**不热（Node 的 ESM 模块缓存按 URL 记），这是 PoC 的明确边界。
  const scanned = await tabs.rescan();
  tabs.watch();

  // 路由分发要靠"这一行现在是不是活的"来兜底：插件的路由表是内存里的，
  // 停用/卸载后不能再由它对外服务。
  // FiberState.ACTIVE === 2（const enum，不能跨包 import，这里用字面量 + 注释）。
  const FIBER_ACTIVE = 2;
  routes.setActivationResolver((pluginId) => {
    // 闸门拦下的行：它在 Loader 里是 disabled，但原因不是"用户停用"，要说清楚
    if (gate.has(pluginId)) return 'rejected';
    for (const entry of ctx.loader.entries()) {
      if (!isPluginEntry(entry)) continue;
      if (shortId(entry.id) !== pluginId) continue;
      if (entry.disabled) return 'disabled';
      if (entry.fiber === undefined) return 'inactive';
      return entry.fiber.state === FIBER_ACTIVE ? 'active' : 'inactive';
    }
    return 'unknown';
  });

  // 7. 装配审计：单插件失败隔离 —— 记录并继续，让设置页能把坏插件显示出来
  //    （契约闸门那种"整行拒绝"已经在挂载前处理了）
  const broken: Array<{ id: string; reason: string }> = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name === 'cordis:include') continue;
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
      profile: options.profile,
      profileDir,
      manifest: fs.existsSync(manifestFile),
      tabsDir,
      tabs: scanned.added.length + scanned.failed.length,
      plugins: [...ctx.loader.entries()].filter((e) => e.options.name !== 'cordis:include').length,
    },
    '宿主内核已装配',
  );

  return {
    ctx,
    space,
    gate,
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
