/**
 * anima-plus 的服务端入口。
 *
 * 这里相当于已被删除的旧单体服务组装根（`apps/server/src/index.ts`）的插件版：
 * 同一批模块，换成宿主提供的两个句柄 —— `ctx.space`（插件私有文件空间）与
 * `ctx.routes`（路由挂载点）。**没有反代：所有接口都由本插件自己提供。**
 *
 * 三点和旧服务不一样，都是有意的：
 *
 * 1. **不建 fastify**。路由挂到 `ctx.routes.for('anima-plus')` 上，实际前缀是
 *    `/api/p/anima-plus`，所以插件内部照旧注册 `/api/*` —— 完整路径与旧服务
 *    逐字一致，前端 `api.ts` 一行都不用改。
 * 2. **不碰宿主的全局错误处理**。旧服务在 `setErrorHandler` 里把 `AppError` 映射成
 *    HTTP 状态码；插件做不到（那是宿主级的），所以改在适配层按 handler 包一层。
 * 3. **没有静态托管 / CORS / 优雅退出**：宿主已经在做，插件只管自己的路由与生命周期。
 *
 * `import.meta.url` 指向打包产物 `server.js`（tab 根），所以资产路径是 `./assets/`。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { buildConfig, type PluginSettings } from './config.js';
import { AppError } from './errors.js';
import { pickSettings, readSettings, seedSettings, settingsFile, writeSettings } from './settings.js';
import { RealComfyClient } from './comfy/real.js';
import { WorkflowDefinition } from './workflow/loader.js';
import { JobManager } from './jobs/manager.js';
import { WeilinClient } from './weilin/client.js';
import { ThumbnailCache } from './weilin/thumb.js';
import { closeDatabase, openDatabase } from './store/db.js';
import { PresetStore } from './store/presets.js';
import { LastStateStore } from './state.js';
import { TriggerStore } from './triggers/store.js';
import { TriggerResolver } from './triggers/resolve.js';
import { registerRoutes } from './http/routes.js';
import { DepsService } from './deps.js';
import { MAX_BODY_BYTES } from './safety/quota.js';
import {
  createRouteHost,
  sendError,
  type PluginContext,
  type PluginLogger,
} from './host.js';

export const name = 'anima-plus';

/** 核只给文件空间；路由是另一个句柄。存储形态由本插件自己决定（D12） */
export const inject = ['routes', 'space'];

const ID = 'anima-plus';
/** 空间按包名分配，所以这里必须写本插件的包名 */
const PACKAGE = '@comfyui-web/anima-plus';

/** 产物在 tab 根（tabs/<id>/server.js）；workflow.json 与它同级（唯一基准），assets/ 放表单声明 */
const PLUGIN_DIR = fileURLToPath(new URL('./', import.meta.url));
const ASSETS_DIR = path.join(PLUGIN_DIR, 'assets');

// ---------------------------------------------------------------------------
// 组装（对应旧服务 main() 的第 1~6 步）
// ---------------------------------------------------------------------------

export async function apply(ctx: PluginContext, legacySettings?: PluginSettings): Promise<void> {
  const space = ctx.space.for(PACKAGE);
  const log = (msg: string) => ctx.logger?.info?.(`[${ID}] ${msg}`);
  const warn = (msg: string) => ctx.logger?.warn?.(`[${ID}] ${msg}`);

  // 设置归插件自己（D15）：值在 `<space>/settings.json`，由本插件的 /api/settings 读写。
  // 清单行的 config 只在**首次**装载时被采信一次（那时它还是本插件唯一的配置来源），采信即落盘。
  if (seedSettings(space, legacySettings)) {
    log(`已把清单里的配置落成 ${settingsFile(space)}（一次性迁移）`);
  }
  const stored = readSettings(space);
  if (stored.error !== undefined) warn(`设置文件读不出来，改用内置默认值：${stored.error}`);

  const config = buildConfig(stored.values, {
    pluginDir: PLUGIN_DIR,
    dbFile: space.resolve('anima-plus.sqlite'),
    cacheDir: space.resolve('cache'),
    dataDir: space.root,
  });

  // 1. 工作流：静态校验失败直接抛 → 装配审计会把它记成"插件激活失败"，设置页可见
  const workflow = new WorkflowDefinition(config.pluginDir, (msg, meta) =>
    warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  );
  await workflow.load();
  log(`工作流已加载 ${Object.keys(workflow.get().graph).length} 个节点`);

  // 2. 插件私有 SQLite（node 内置，零原生依赖）
  const db = openDatabase(config.dbFile, (msg, meta) =>
    warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  );
  const presets = new PresetStore(db);
  log(`库已就绪 ${config.dbFile}`);

  // 3. ComfyUI 客户端：所有任务共用同一个 client_id（进度只投给提交者）
  const clientId = randomUUID();
  const client = new RealComfyClient({
    baseUrl: config.comfyBaseUrl,
    clientId,
    log: (msg, meta) => ctx.logger?.debug?.(`[${ID}] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
  });
  await client.start();

  // 4. WeiLin 适配层（复用它在 ComfyUI 上注册的 REST 路由；不读本地库）。
  //    放在依赖检查之前：任务编排要用它解析触发词（server/triggers/resolve.ts）。
  const weilin = new WeilinClient({
    baseUrl: config.comfyBaseUrl,
    mode: config.comfyMode,
    log: (msg, meta) =>
      ctx.logger?.debug?.(`[${ID}] [weilin] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
  });
  const weilinStatus = await weilin.probe();
  if (weilinStatus.available) {
    log(`WeiLin 已就绪，LoRA ${weilinStatus.total} 个`);
  } else {
    warn(`WeiLin 不可用（标签/LoRA 面板降级，出图不受影响）：${weilinStatus.message}`);
  }

  // 5. 依赖检查（模板需要的节点类 vs 上游 /object_info）+ 任务编排 + 缩略图缓存
  const deps = new DepsService(
    client,
    workflow,
    (msg, meta) => warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
    // 缓存时长来自设置项（0 = 每次重查，见 config.ts）
    { ttlMs: config.depsCacheTtlMs },
  );
  // 预热：不 await（别拖慢激活），只是让首屏那次检查走缓存；结果打进日志便于排障。
  // 设置页可关（depsWarmupOnStart=false）：ComfyUI 还没起来时少一条无谓的失败日志。
  if (config.depsWarmupOnStart) {
    void deps
      .report()
      .then((r) => {
        if (r.ok === null) warn(`依赖检查未完成（ComfyUI 不可达）：${r.error ?? ''}`);
        else if (r.ok) log(`依赖齐全（上游已注册节点 ${r.nodeCount ?? 0} 个）`);
        else warn(`缺少 ${r.missing.length} 个节点：${r.missing.map((m) => m.classType).join('、')}`);
      })
      .catch(() => {
        /* 预热失败不影响任何功能：界面自己会再查一次 */
      });
  }

  // 触发词：覆盖表（用户自管，`<space>/triggers.json`）+ 解析器
  //（提交与 /api/triggers/resolve 预览共用前者，保证"看到的就是注入的"）
  const triggerStore = new TriggerStore(space, (msg, meta) =>
    warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  );
  const triggers = new TriggerResolver(triggerStore, weilin, (msg, meta) =>
    warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  );

  // 上次提交的参数快照（`<space>/last-state.json`）：每次点「开始生成」覆盖一次。
  // 内存里不留副本 —— 它就是"刷新页面要回填的那一份"，直接以文件为准（读盘只在页面加载时）。
  const lastState = new LastStateStore(space, (msg, meta) =>
    warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  );

  const jobs = new JobManager(client, workflow, {
    clientId,
    deps,
    triggers,
    // 并发与历史长度都来自设置项（JobManager 本来就支持注入，见其 ManagerOptions）
    maxQueueDepth: config.maxQueueDepth,
    maxJobsRetained: config.maxJobsRetained,
    log: (msg, meta) => log(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  });
  jobs.start();
  const thumbs = new ThumbnailCache(path.join(config.cacheDir, 'loras-thumbs'), (msg, meta) =>
    ctx.logger?.debug?.(`[${ID}] [thumb] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
  );

  // 6. 路由：内部路径与旧服务逐字一致 → 完整路径 /api/p/anima-plus/api/*
  const routes = ctx.routes.for(ID);
  await registerRoutes(createRouteHost(routes, ctx.logger ?? {}), {
    config,
    workflow,
    jobs,
    client,
    weilin,
    thumbs,
    presets,
    state: lastState,
    triggers: { store: triggerStore, resolver: triggers },
    deps,
  });

  // 设置端点：设置归插件自己（D15）。字段的**形状**写在 package.json 的 plugin.settings 里，
  // 值住在这里 —— 存完由前端请求宿主的 `POST /api/tabs/:id/reload`，让本插件重新 apply()。
  routes.get('/api/settings', async () => ({
    values: stored.values,
    effective: {
      comfyuiBaseUrl: config.comfyBaseUrl,
      maxQueueDepth: config.maxQueueDepth,
      maxJobsRetained: config.maxJobsRetained,
      depsWarmupOnStart: config.depsWarmupOnStart,
      depsCacheTtlMinutes: config.depsCacheTtlMs / 60_000,
    },
    file: stored.file,
    ...(stored.error !== undefined ? { error: stored.error } : {}),
  }));

  routes.put('/api/settings', async (request: any) => {
    const body = request?.body;
    const incoming =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as { values?: unknown }).values
        : undefined;
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw AppError.badRequest('请求体必须是 { values: {…} }：键与 package.json 的 plugin.settings 同名');
    }
    // 值原样落盘、**不在这里收敛**：范围与回落在 buildConfig 里一处决定（/config 会露出结论）
    const next = pickSettings(incoming as Record<string, unknown>);
    const file = writeSettings(space, next);
    log(`设置已更新 ${file}（重新挂载后生效）`);
    return { values: next, file, reloadRequired: true };
  });

  // 自检端点：设置页/排障时一眼看到生效的地址与空间
  routes.get('/config', async () => ({
    comfyBaseUrl: config.comfyBaseUrl,
    maxQueueDepth: config.maxQueueDepth,
    maxJobsRetained: config.maxJobsRetained,
    depsWarmupOnStart: config.depsWarmupOnStart,
    depsCacheTtlMs: config.depsCacheTtlMs,
    pluginDir: config.pluginDir,
    dataDir: config.dataDir,
    dbFile: config.dbFile,
    weilin: weilinStatus,
    configFiles: config.configFiles,
  }));

  log(`已就绪，ComfyUI = ${config.comfyBaseUrl}`);

  // 7. 生命周期：cordis 卸载时自动撤销（对应旧服务的 shutdown）
  ctx.effect?.(() => () => {
    jobs.stop();
    void client.stop();
    closeDatabase(db);
    log('已卸载');
  });
}
