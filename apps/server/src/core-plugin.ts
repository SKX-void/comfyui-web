import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context } from 'cordis';
import type { Entry } from '@cordisjs/plugin-loader';
import type { FastifyInstance } from 'fastify';

import { SUPPORTED_CONTRACT } from './plugin-package.js';
import { readUiPrefs, writeUiPrefs, type UiPrefs } from './ui-prefs.js';
import { isBlank, type HostGlobals, type SettingSource } from './host-globals.js';
import type { PluginPackageManifest, PluginSettingField, ResolvedPluginPackage } from './plugin-package.js';

/**
 * 宿主内置 core 插件：提供 v2 的宿主级端点。
 *
 * 它不是 plugs.yml 里的插件，而是宿主自己 mount 的 cordis 插件 ——
 * 因为这几条路由是**宿主级**路径（`/api/plugins`、`/plugins/*`），
 * 不属于 `/api/p/<pluginId>` 的插件前缀约定。
 *
 * 端点：
 *   GET  /api/host                      宿主信息（profile / 端口 / 契约版本）
 *   GET  /api/plugins                   插件清单（唯一真源 = 后端 Loader）
 *   PUT  /api/plugins/:id/config        写配置（经 Loader → Include 写回 plugins.yml）
 *   PUT  /api/plugins/:id/enabled       运行期启停（不写文件）
 *   GET  /api/ui                        外壳偏好 + 宿主全局设置（统一 ComfyUI 地址）
 *   PUT  /api/ui                        写这两样（<dataDir>/ui-prefs.json）
 *   GET  /plugins/:id/*                 插件前端产物（从包目录直送，不复制进 dist）
 */
export interface CorePluginConfig {
  app: FastifyInstance;
  profile: string;
  profileDir: string;
  manifestFile: string;
  /** 数据目录：外壳偏好存在 `<dataDir>/ui-prefs.json` */
  dataDir: string;
  /** 模块说明符 → 插件包 */
  resolvePackage: (specifier: string) => ResolvedPluginPackage | undefined;
  /** 契约闸门：行 id → 拒绝原因（这些行已被 patch 层禁用，未真正加载） */
  gate: Map<string, string>;
  /** 读清单文件里的原始配置（行 id → config）；每次现读，不缓存 */
  readRawConfigs: () => Map<string, Record<string, unknown>>;
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
  rowId: string;
  specifier: string;
  enabled: boolean;
  phase: Phase;
  title: string;
  icon?: string;
  order: number;
  packageName?: string;
  version?: string;
  clientUrl?: string;
  settings: PluginSettingField[];
  config: unknown;
  /** 声明了 fallback 的字段：值从哪来（设置页显示「跟随统一 / 自定 / 都空」） */
  sources?: Record<string, SettingSource>;
  error?: string;
}

/** `include:anima-plus` → `anima-plus` */
export function shortId(entryId: string): string {
  const index = entryId.indexOf(':');
  return index === -1 ? entryId : entryId.slice(index + 1);
}

/** 清单行（不是 include 自己） */
export function isPluginEntry(entry: Entry): boolean {
  return entry.options.name !== 'cordis:include';
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
  /** 外壳偏好文件：data 目录才是"本装置自己的可写状态"（host.config.json 在 docker 里只读） */
  const uiPrefsFile = path.join(config.dataDir, 'ui-prefs.json');

  const resolveCached = ((): ((specifier: string) => ResolvedPluginPackage | undefined) => {
    const cache = new Map<string, ResolvedPluginPackage | undefined>();
    return (specifier: string) => {
      if (!cache.has(specifier)) cache.set(specifier, config.resolvePackage(specifier));
      return cache.get(specifier);
    };
  })();

  /** 取一行插件的完整描述（含失败原因） */
  async function describe(
    entry: Entry,
    raws: Map<string, Record<string, unknown>>,
  ): Promise<PluginRow> {
    const id = shortId(entry.id);
    const specifier = entry.options.name;
    const pkg = resolveCached(specifier);
    const manifest: PluginPackageManifest = pkg?.manifest ?? {};
    const rejected = config.gate.get(id);

    let phase: Phase;
    let error: string | undefined;

    if (rejected !== undefined) {
      phase = 'rejected';
      error = rejected;
    } else if (entry.disabled) {
      phase = 'disabled';
    } else if (entry.fiber === undefined) {
      // 导入失败的判据：无 fiber 且未禁用（与 dsh 的 assertEntriesLoaded 同款）
      phase = 'unresolved';
      error = await importFailure(ctx, specifier);
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
      manifest.client !== undefined && pkg !== undefined
        ? `/plugins/${id}/${manifest.client.replace(/^\.\//, '')}`
        : undefined;

    // 声明了 fallback 的字段：值从哪来（设置页据此显示"跟随统一 / 自定 / 都没填"）
    const prefs = currentPrefs();
    const sources = sourcesOf(id, manifest.settings ?? [], raws.get(id), prefs);

    return {
      id,
      rowId: entry.id,
      specifier,
      enabled: !entry.disabled,
      phase,
      title: manifest.title ?? id,
      ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
      order: manifest.order ?? 100,
      ...(pkg?.packageName !== undefined ? { packageName: pkg.packageName } : {}),
      ...(pkg?.version !== undefined ? { version: pkg.version } : {}),
      ...(clientUrl !== undefined ? { clientUrl } : {}),
      settings: manifest.settings ?? [],
      // 配置对前端脱敏：secret 字段只回传"是否已设置"，跟随统一设置的项显示成留空
      config: redactConfig(
        viewConfig(id, raws.get(id), manifest.settings ?? [], prefs),
        manifest.settings ?? [],
      ),
      ...(Object.keys(sources).length > 0 ? { sources } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async function listRows(): Promise<PluginRow[]> {
    const rows: PluginRow[] = [];
    const raws = config.readRawConfigs();
    for (const entry of ctx.loader.entries()) {
      // 跳过 include 自己（配置文件那一行）
      if (entry.options.name === 'cordis:include') continue;
      rows.push(await describe(entry, raws));
    }
    rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return rows;
  }

  function findEntry(id: string): Entry | undefined {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name === 'cordis:include') continue;
      if (shortId(entry.id) === id) return entry;
    }
    return undefined;
  }

  // ---- 宿主全局设置 → 跟随它的插件 ---------------------------------------

  /** 跟随对齐的串行队列：两次重算叠在一起没意义，排队更可预期 */
  let reconcileQueue: Promise<unknown> = Promise.resolve();
  /** 写一行配置后最多等多久（毫秒）：超过就先回响应，重载在后台继续 */
  const FOLLOWER_SETTLE_MS = 3000;


  /** 当前偏好（含 globals 与跟随名单）：每次现读（设置页刚写完就要用），不缓存 */
  function currentPrefs(): UiPrefs {
    return readUiPrefs(uiPrefsFile);
  }

  /** 某一项的值由谁提供：跟随统一设置 / 插件自定 / 两边都没填 */
  function sourcesOf(
    id: string,
    settings: PluginSettingField[],
    raw: Record<string, unknown> | undefined,
    prefs: UiPrefs,
  ): Record<string, SettingSource> {
    const sources: Record<string, SettingSource> = {};
    for (const field of settings) {
      if (field.fallback === undefined) continue;
      if (prefs.following.includes(id)) sources[field.key] = 'host';
      else if (isBlank(raw?.[field.key])) sources[field.key] = 'unset';
      else sources[field.key] = 'plugin';
    }
    return sources;
  }

  /**
   * 回给设置页看的配置：文件里的值，但**跟随统一设置**的那些项显示成空。
   *
   * 跟随者的文件里存的是宿主写进去的统一值；照原样回传的话，用户会以为是自己填的，
   * 一保存就把它固化成"自定"。所以对前端而言：跟随 == 留空。
   */
  function viewConfig(
    id: string,
    raw: Record<string, unknown> | undefined,
    settings: PluginSettingField[],
    prefs: UiPrefs,
  ): Record<string, unknown> | null {
    if (raw === undefined) return null;
    if (!prefs.following.includes(id)) return raw;
    const view = { ...raw };
    for (const field of settings) {
      if (field.fallback !== undefined) view[field.key] = '';
    }
    return view;
  }

  /**
   * 把统一设置写进"跟随中"的插件行（并跳过已经一致的）。
   *
   * 为什么写行配置而不是 Loader 的补丁层：补丁只活在内存里，改一次要重排整棵子树
   * —— 实测会卡住宿主几十秒，而且补丁盖着的键写不进文件。写行配置走的是插件设置
   * 本来就在用的那条路：落盘 + 就地重载，行为可预期。代价是文件里存的是**解析后的
   * 地址**；"谁在跟随"由 ui-prefs.json 的 following 名单负责（见 docs/architecture.md §5.7）。
   */
  async function reconcileFollowers(): Promise<string[]> {
    const run = reconcileQueue.then(() => reconcileFollowersNow());
    reconcileQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function reconcileFollowersNow(): Promise<string[]> {
    const prefs = currentPrefs();
    const following = new Set(prefs.following);
    const blank = isBlank(prefs.globals.comfyuiBaseUrl);
    const written: string[] = [];

    for (const entry of ctx.loader.entries()) {
      if (!isPluginEntry(entry)) continue;
      const id = shortId(entry.id);
      const settings = resolveCached(entry.options.name)?.manifest.settings ?? [];
      const fields = settings.filter(
        (field) => field.fallback !== undefined && field.fallback in prefs.globals,
      );
      if (fields.length === 0) continue;

      const raw = config.readRawConfigs().get(id) ?? {};
      // 「跟随」的判定：名单里有它，**或者**它在文件里留空（留空就是设置页的"跟随"语义，
      // 名单只是这份语义的持久记录 —— 第一次设统一地址时，名单还是空的）。
      const listed = following.has(id);
      const follows = listed || (!blank && fields.some((field) => isBlank(raw[field.key])));
      if (!follows) {
        following.delete(id);
        continue;
      }
      if (blank) following.delete(id);
      else following.add(id);

      const next: Record<string, unknown> = { ...raw };
      let changed = false;
      for (const field of fields) {
        const want = blank ? '' : prefs.globals[field.fallback as keyof HostGlobals] ?? '';
        if (next[field.key] !== want) {
          next[field.key] = want;
          changed = true;
        }
      }
      if (!changed) continue; // 已经一致就别动它，省一次重载

      try {
        await ctx.loader.update(entry.id, { config: next });
        await settleLoader(FOLLOWER_SETTLE_MS);
        written.push(id);
      } catch (err) {
        console.warn(
          `[host] 把统一设置写进插件 ${id} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 名单有变化就落盘（统一设置被清空时也会走到这里：名单清空，各行刚被写回空值）
    const after = [...following];
    if (after.length !== prefs.following.length || after.some((id) => !prefs.following.includes(id))) {
      try {
        writeUiPrefs(uiPrefsFile, { ...prefs, following: after });
      } catch (err) {
        console.warn(`[host] 保存跟随名单失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return written;
  }

  /** 等 Loader 把当前这批重载收尾，但**最多**等 ms 毫秒（插件重新激活可能很久） */
  async function settleLoader(ms: number): Promise<boolean> {
    return Promise.race([
      ctx.loader.await().then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), ms);
      }),
    ]);
  }

  // 启动时对齐一次：统一设置在宿主停机期间变过、或某个跟随插件的行配置被手改过，都在这里补上。
  // 不 await：插件可能还在激活，写下去 Loader 会排队处理。
  void reconcileFollowers().catch((err) => {
    console.warn(
      `[host] 对齐跟随统一设置的插件失败：${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // ---- 宿主信息 ----------------------------------------------------------

  app.get('/api/host', async () => ({
    profile: config.profile,
    profileDir: config.profileDir,
    manifestFile: config.manifestFile,
    contract: SUPPORTED_CONTRACT,
  }));

  // ---- 插件清单（唯一真源）------------------------------------------------

  app.get('/api/plugins', async () => ({ plugins: await listRows() }));

  // ---- 运行期启停 --------------------------------------------------------

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/plugins/:id/enabled',
    async (request, reply) => {
      const entry = findEntry(request.params.id);
      if (!entry) return reply.code(404).send({ error: `未知插件 ${request.params.id}` });
      if (config.gate.has(request.params.id)) {
        return reply.code(409).send({
          error: `插件 ${request.params.id} 未通过契约闸门，无法启用：${config.gate.get(request.params.id) ?? ''}`,
        });
      }
      const enabled = request.body?.enabled !== false;
      await ctx.loader.update(entry.id, { disabled: !enabled });
      await ctx.loader.await();
      return { plugin: await describe(ctx.loader.resolve(entry.id), config.readRawConfigs()) };
    },
  );

  // ---- 配置读写（写回 plugins.yml）---------------------------------------

  app.put<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>(
    '/api/plugins/:id/config',
    async (request, reply) => {
      const entry = findEntry(request.params.id);
      if (!entry) return reply.code(404).send({ error: `未知插件 ${request.params.id}` });
      const next = request.body?.config;
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        return reply.code(400).send({ error: 'config 必须是对象' });
      }
      const fields = resolveCached(entry.options.name)?.manifest.settings ?? [];
      const restored = restoreMaskedSecrets(
        next as Record<string, unknown>,
        entry.options.config,
        fields,
      );
      // 这一项留空 = 跟随统一设置：把统一值写进这一行，并把这个插件记进跟随名单；
      // 填了 = 自定：原样写进文件，同时把它从跟随名单里摘掉。
      const prefs = currentPrefs();
      const following = new Set(prefs.following);
      const toWrite: Record<string, unknown> = { ...restored };
      for (const field of fields) {
        if (field.fallback === undefined) continue;
        const globalKey = field.fallback as keyof HostGlobals;
        const globalValue = prefs.globals[globalKey];
        if (!isBlank(toWrite[field.key])) {
          following.delete(request.params.id);
        } else if (typeof globalValue === 'string' && globalValue !== '') {
          toWrite[field.key] = globalValue;
          following.add(request.params.id);
        } else {
          // 两边都留空：就是没填，用插件自己的内置默认值
          following.delete(request.params.id);
        }
      }

      try {
        await ctx.loader.update(entry.id, { config: toWrite });
        await settleLoader(FOLLOWER_SETTLE_MS);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      // 跟随名单也落盘；写不进去不影响插件本身，但要让用户知道
      let warning: string | undefined;
      if (following.size !== prefs.following.length || [...following].some((id) => !prefs.following.includes(id))) {
        try {
          writeUiPrefs(uiPrefsFile, { ...prefs, following: [...following] });
        } catch (err) {
          warning = `插件配置已生效，但跟随名单没存下来：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const plugin = await describe(ctx.loader.resolve(entry.id), config.readRawConfigs());
      return warning === undefined ? { plugin } : { plugin, warning };
    },
  );

  // ---- 外壳偏好 + 宿主全局设置 -------------------------------------------
  // 存 <dataDir>/ui-prefs.json。后端只保证「读得到、写得进、坏文件不炸」：
  // 未知插件 id 的过滤与默认首页的回退都在前端做（它才看得到实时清单）。
  //
  // globals（统一 ComfyUI 地址）是这里唯一会影响插件的一份：写完立刻把新值写进
  // 跟随它的那些插件的行配置（只有它们会重载，其余插件的 fiber 原样保留）。

  app.get('/api/ui', async () => ({ prefs: readUiPrefs(uiPrefsFile) }));

  app.put<{ Body: { tabOrder?: unknown; home?: unknown; globals?: unknown } }>(
    '/api/ui',
    async (request, reply) => {
      let prefs: UiPrefs;
      try {
        // following 是**宿主自己维护**的状态：客户端没带就沿用现有的，别把跟随名单清空
        // （只带 tabOrder/home/globals 的客户端是很正常的写法）。
        const body: Record<string, unknown> = { ...(request.body ?? {}) };
        if (body.following === undefined) {
          body.following = readUiPrefs(uiPrefsFile).following;
        }
        prefs = writeUiPrefs(uiPrefsFile, body);
      } catch (err) {
        // 写不进去（只读挂载 / 磁盘满）必须给出可读原因，而不是静默不保存
        return reply
          .code(500)
          .send({ error: `写外壳偏好失败：${err instanceof Error ? err.message : String(err)}` });
      }

      // 把新值写进插件行会触发插件重载（anima-plus 激活要枚举模型/查依赖，可能几十秒），
      // 让设置页干等没意义：名单已经落盘，"谁在跟随"立刻就是对的，写盘与重载放后台。
      const following = readUiPrefs(uiPrefsFile).following;
      void reconcileFollowers().catch((err) => {
        console.warn(
          `[host] 把统一设置写进跟随它的插件失败：${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return { prefs: currentPrefs(), following };
    },
  );

  // ---- 插件前端产物托管 --------------------------------------------------
  // 关键：从 profile 的 node_modules 真实路径直送，**不复制进 dist**。
  // 一旦改成"构建期拷贝"，整个方案就退化成混合编译了（v2-architecture §5.3）。

  app.get<{ Params: { id: string; '*': string } }>('/plugins/:id/*', async (request, reply) => {
    const id = request.params.id;
    const entry = findEntry(id);
    if (!entry) return reply.code(404).send({ error: `未知插件 ${id}` });

    const pkg = resolveCached(entry.options.name);
    if (!pkg) return reply.code(404).send({ error: `无法解析插件包 ${entry.options.name}` });

    const rel = request.params['*'];
    const target = path.resolve(pkg.dir, rel);
    const guard = pkg.dir.endsWith(path.sep) ? pkg.dir : pkg.dir + path.sep;
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

/** 与前端约定的脱敏占位（SchemaForm 的 MASK 必须与此一致） */
const SECRET_MASK = '••••••';

/**
 * 密钥字段是**只写**的：宿主不把原值发给前端，前端原样回传占位符表示"保持不变"。
 * 这里把占位符换回真实值，避免"点一次保存就把密钥抹掉"。
 */
function restoreMaskedSecrets(
  next: Record<string, unknown>,
  current: unknown,
  fields: PluginSettingField[],
): Record<string, unknown> {
  const secretKeys = fields.filter((field) => field.secret === true).map((field) => field.key);
  if (secretKeys.length === 0) return next;

  const previous =
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const output = { ...next };
  for (const key of secretKeys) {
    if (output[key] !== SECRET_MASK) continue;
    if (previous[key] !== undefined) output[key] = previous[key];
    else delete output[key];
  }
  return output;
}

/** 对 secret 字段脱敏：只回传"是否已设置"，不回传值 */
function redactConfig(
  config: unknown,
  fields: PluginSettingField[],
): Record<string, unknown> | null {
  if (config === null || config === undefined) return null;
  if (typeof config !== 'object' || Array.isArray(config)) return { value: config };
  const source = config as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const secretKeys = new Set(fields.filter((f) => f.secret === true).map((f) => f.key));
  for (const [key, value] of Object.entries(source)) {
    output[key] = secretKeys.has(key) ? (value === undefined || value === '' ? '' : '••••••') : value;
  }
  return output;
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
