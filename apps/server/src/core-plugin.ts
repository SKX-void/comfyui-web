import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'cordis';
import type { Entry } from '@cordisjs/plugin-loader';
import type { FastifyInstance } from 'fastify';

import { readHostSettings, settingsView, writeHostSettings } from './host-settings.js';
import { SUPPORTED_CONTRACT } from './plugin-package.js';
import type { PluginPackageManifest, PluginSettingField } from './plugin-package.js';
import type { ScannedTab } from './tabs.js';

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
 *   PUT  /api/plugins/:id/enabled       运行期启停（不写文件）
 *   POST /api/tabs/rescan               重扫 /tabs 并增量装载（D20：唯一会改装载状态的入口）
 *   POST /api/tabs/:id/reload           强制重挂一个 tab（配置归插件自己，D15）
 *   GET  /api/ui                        外壳偏好 + 宿主全局设置（统一 ComfyUI 地址）
 *   PUT  /api/ui                        写这两样（<dataDir>/host.json 的偏好段）
 *   GET  /plugins/:id/*                 插件前端产物（从 tab 目录直送，不复制进 dist）
 */
export interface CorePluginConfig {
  app: FastifyInstance;
  /** tab 插件目录（目录型工作流插件；见 src/tabs.ts） */
  tabsDir: string;
  /** 目录型 tab 的注册表：清单、手动重扫、重挂 */
  tabs: {
    /** **已装载**的 tab（row 的唯一来源）：没点重扫的目录不在里面 */
    scan(): ScannedTab[];
    /** 按 id 取一格 tab（拿入口路径与包元数据） */
    get(id: string): ScannedTab | undefined;
    rescan(): Promise<{
      added: string[];
      removed: string[];
      reloaded: string[];
      failed: Array<{ id: string; reason: string }>;
    }>;
    owns(id: string): boolean;
    /** 重挂一个 tab：目录型插件自持配置，改完要重新 apply() 才生效（D15） */
    reload(id: string): Promise<boolean>;
  };
  /** 数据目录：宿主配置与外壳偏好都在 `<dataDir>/host.json` */
  dataDir: string;
}

export const name = 'host-core';

/** 需要 Loader 服务（清单的唯一真源就是它）；cordis 要求依赖必须显式声明 */
export const inject = ['loader'];

type Phase =
  | 'active'
  | 'pending'
  | 'loading'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'unresolved'
  | 'disabled'
  | 'rejected';

const FIBER_STATE_LABEL: Record<number, Phase> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
};

interface PluginRow {
  id: string;
  /** 服务端入口绝对路径（设置页拿它排障） */
  entry: string;
  enabled: boolean;
  phase: Phase;
  title: string;
  icon?: string;
  order: number;
  packageName?: string;
  version?: string;
  clientUrl?: string;
  /** 字段**形状**（元数据，来自 package.json）；值住在插件自己的空间里 */
  settings: PluginSettingField[];
  error?: string;
}

/** `include:anima-plus` → `anima-plus` */
export function shortId(entryId: string): string {
  const index = entryId.indexOf(':');
  return index === -1 ? entryId : entryId.slice(index + 1);
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function apply(ctx: Context, config: CorePluginConfig): void {
  const { app } = config;
  /** 宿主配置文件（部署段 + 运行期偏好同住一个文件，见 host-settings.ts） */
  const settingsFile = path.join(config.dataDir, 'host.json');

  /** 取一格 tab 的完整描述（含失败原因）；entry 可能不存在（没挂上 / 挂失败） */
  async function describe(tab: ScannedTab): Promise<PluginRow> {
    const id = tab.id;
    const entry = findEntry(id);
    const manifest: PluginPackageManifest = tab.pkg?.manifest ?? {};

    let phase: Phase;
    let error: string | undefined;

    if (tab.problem !== undefined) {
      // 目录本身没通过检查：它以 disabled 挂着，这里把原因原样交给设置页
      phase = 'rejected';
      error = tab.problem;
    } else if (entry === undefined) {
      phase = 'unresolved';
      error = '没有挂进 Loader（重扫后仍未装载）';
    } else if (entry.disabled) {
      phase = 'disabled';
    } else if (entry.fiber === undefined) {
      // 导入失败的判据：无 fiber 且未禁用（与 dsh 的 assertEntriesLoaded 同款）
      phase = 'unresolved';
      error = await importFailure(ctx, entry.options.name);
    } else {
      const state = entry.fiber.state;
      phase = FIBER_STATE_LABEL[state] ?? 'pending';
      if (phase === 'failed') {
        try {
          await entry.fiber.await();
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const clientUrl =
      manifest.client !== undefined
        ? `/plugins/${id}/${manifest.client.replace(/^\.\//, '')}`
        : undefined;

    return {
      id,
      entry: tab.entry,
      enabled: entry !== undefined && !entry.disabled,
      phase,
      title: manifest.title ?? id,
      ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
      order: manifest.order ?? 100,
      ...(tab.pkg?.packageName !== undefined ? { packageName: tab.pkg.packageName } : {}),
      ...(tab.pkg?.version !== undefined ? { version: tab.pkg.version } : {}),
      ...(clientUrl !== undefined ? { clientUrl } : {}),
      settings: manifest.settings ?? [],
      ...(error !== undefined ? { error } : {}),
    };
  }

  async function listRows(): Promise<PluginRow[]> {
    const rows: PluginRow[] = [];
    // 只列**已装载**的 tab（含没通过检查的那些，它们也要显示原因）：目录里刚放进来、
    // 还没点重扫的插件不出现在这里 —— 免得界面显示一个"看得见但点不开"的 tab
    for (const tab of config.tabs.scan()) {
      rows.push(await describe(tab));
    }
    rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return rows;
  }

  function findEntry(id: string): Entry | undefined {
    for (const entry of ctx.loader.entries()) {
      if (shortId(entry.id) === id) return entry;
    }
    return undefined;
  }




  // ---- 宿主信息 ----------------------------------------------------------

  app.get('/api/host', async () => ({
    dataDir: config.dataDir,
    tabsDir: config.tabsDir,
    contract: SUPPORTED_CONTRACT,
  }));

  // ---- 目录型 tab（`/tabs/<id>/`）----------------------------------------

  /**
   * 重扫 `/tabs` —— **唯一会改动装载状态的入口**（D20：宿主不监听目录，壳里给了按钮）。
   *
   * 增量：新目录挂上、指纹变了的带 `?v=` 重挂、目录没了的卸掉。返回这四个列表，
   * 前端据此说清"到底发生了什么"（而不是只说一句"刷新成功"）。
   */
  app.post('/api/tabs/rescan', async () => config.tabs.rescan());

  /**
   * 强制重挂一个目录型 tab（指纹没变也重挂）。
   *
   * 目录型插件的配置归它自己（`ctx.space` 里的文件），改完设置要重新 `apply()` 才生效：
   * 宿主不碰它的配置，只提供"重新走一遍装载"这一个动作（决策 D15）。
   */
  app.post<{ Params: { id: string } }>('/api/tabs/:id/reload', async (request, reply) => {
    const id = request.params.id;
    const tab = config.tabs.get(id);
    if (tab === undefined || !config.tabs.owns(id)) {
      return reply.code(404).send({ error: `不是目录型 tab：${id}` });
    }
    const ok = await config.tabs.reload(id);
    if (!ok) {
      return reply.code(409).send({ error: `重挂 ${id} 失败：目录已变化或入口不可用（看设置页的 reasons）` });
    }
    return { reloaded: id, plugin: await describe(tab) };
  });

  // ---- 插件清单（唯一真源）------------------------------------------------

  app.get('/api/plugins', async () => ({ plugins: await listRows() }));

  // ---- 运行期启停 --------------------------------------------------------

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/plugins/:id/enabled',
    async (request, reply) => {
      const id = request.params.id;
      const tab = config.tabs.get(id);
      const entry = findEntry(id);
      if (tab === undefined || entry === undefined) {
        return reply.code(404).send({ error: `未知插件 ${id}` });
      }
      // 没通过检查的 tab（契约不符 / 入口缺失）本来就以 disabled 挂着，启用它没有意义
      if (tab.problem !== undefined) {
        return reply.code(409).send({ error: `tab ${id} 未通过检查，无法启用：${tab.problem}` });
      }
      const enabled = request.body?.enabled !== false;
      await ctx.loader.update(entry.id, { disabled: !enabled });
      await ctx.loader.await();
      return {
        plugin: await describe(tab),
        // 目录型 tab 的启停是运行期状态，宿主不落盘（它的状态归插件自己在 data/ 里管）
        warning: '目录型 tab 的启停不落盘：重启后回到 /tabs 目录的默认状态',
      };
    },
  );

  // ---- 外壳偏好 + 宿主全局设置 -------------------------------------------
  // 存 <dataDir>/host.json（与部署段同处一个文件）。后端只保证「读得到、写得进、坏文件不炸」：
  // 未知插件 id 的过滤与默认首页的回退都在前端做（它才看得到实时清单）。
  //
  // globals.comfyuiBaseUrl（统一 ComfyUI 地址）只是宿主给的一个**只读默认值**：
  // 宿主不再把它写进任何插件，插件要么自己配、要么把它当兜底（D16）。

  app.get('/api/ui', async () => ({ prefs: settingsView(readHostSettings(settingsFile)) }));

  app.put<{ Body: { tabOrder?: unknown; home?: unknown; globals?: unknown } }>(
    '/api/ui',
    async (request, reply) => {
      try {
        const body: Record<string, unknown> = { ...(request.body ?? {}) };
        // 这一层只认偏好段的三个键：data/host.json 里还住着部署段（端口等），
        // 设置页不该靠这次提交改掉它们。
        const patch: Record<string, unknown> = {
          tabOrder: body.tabOrder,
          home: body.home,
          globals: body.globals,
        };
        for (const key of Object.keys(patch)) {
          if (patch[key] === undefined) delete patch[key];
        }
        const current = readHostSettings(settingsFile);
        const prefs = writeHostSettings(settingsFile, { ...current, ...patch });
        return { prefs: settingsView(prefs) };
      } catch (err) {
        // 写不进去（只读挂载 / 磁盘满）必须给出可读原因，而不是静默不保存
        return reply
          .code(500)
          .send({ error: `写外壳偏好失败：${err instanceof Error ? err.message : String(err)}` });
      }
    },
  );

  // ---- 插件前端产物托管 --------------------------------------------------
  // 关键：从 tab 目录的真实路径直送，**不复制进 dist**。
  // 一旦改成"构建期拷贝"，整个方案就退化成混合编译了（docs/architecture.md §5.3）。

  app.get<{ Params: { id: string; '*': string } }>('/plugins/:id/*', async (request, reply) => {
    const id = request.params.id;
    const tab = config.tabs.get(id);
    if (tab === undefined) return reply.code(404).send({ error: `未知插件 ${id}` });

    const rel = request.params['*'];
    const target = path.resolve(tab.dir, rel);
    const guard = tab.dir.endsWith(path.sep) ? tab.dir : tab.dir + path.sep;
    if (!target.startsWith(guard)) {
      return reply.code(403).send({ error: '路径越界' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return reply.code(404).send({ error: `不存在 ${rel}` });
    }

    reply.type(MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
    // 插件产物随包更新，宿主不做缓存判断 —— 交给浏览器协商
    reply.header('cache-control', 'no-cache');
    return reply.send(fs.createReadStream(target));
  });
}

/** 为"模块导入失败"的行补一条可读原因（错误只进了 Loader 日志，这里复现一次） */
async function importFailure(ctx: Context, specifier: string): Promise<string> {
  try {
    await ctx.loader.import(specifier);
    return '插件模块未激活（可能依赖的服务缺席）';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
