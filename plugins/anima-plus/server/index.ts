/**
 * anima-plus 的服务端入口。
 *
 * 这里是旧服务 `apps/server/src/index.ts`（组装根）的插件版：
 * 同一批模块，换成宿主提供的两个句柄 —— `ctx.space`（插件私有文件空间）与
 * `ctx.routes`（路由挂载点）。**不再有反代，8086 也不再需要。**
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
 * `import.meta.url` 指向打包产物 `lib/server.js`，所以资产路径是 `../assets/`。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { buildConfig, type PluginSettings } from './config.js';
import { AppError } from './errors.js';
import { RealComfyClient } from './comfy/real.js';
import { TemplateRegistry } from './templates/loader.js';
import { JobManager } from './jobs/manager.js';
import { WeilinClient } from './weilin/client.js';
import { ThumbnailCache } from './weilin/thumb.js';
import { closeDatabase, openDatabase } from './store/db.js';
import { PresetStore } from './store/presets.js';
import { registerRoutes } from './http/routes.js';
import { DepsService } from './deps.js';
import { MAX_BODY_BYTES } from './safety/quota.js';

export const name = 'anima-plus';

/** 核只给文件空间；路由是另一个句柄。存储形态由本插件自己决定（D12） */
export const inject = ['routes', 'space'];

const ID = 'anima-plus';
/** 空间按包名分配，所以这里必须写本插件的包名 */
const PACKAGE = '@comfyui-web/anima-plus';

/** 打包产物在 lib/ 下，资产在包根的 assets/ */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));

// ---------------------------------------------------------------------------
// 宿主句柄的最小类型（插件不 import cordis，也不 import 宿主源码）
// ---------------------------------------------------------------------------

type RouteHandler = (request: any, reply: any) => unknown;

interface PluginRoutes {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  all(path: string, handler: RouteHandler): void;
}

interface PluginSpace {
  packageName: string;
  root: string;
  resolve(rel: string): string;
}

interface PluginLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

interface PluginContext {
  routes: { for(pluginId: string): PluginRoutes };
  space: { for(packageName: string): PluginSpace };
  logger?: PluginLogger;
  effect?: (fn: () => () => void) => void;
}

// ---------------------------------------------------------------------------
// 适配层：让搬过来的 http/routes.ts 一字不改
// ---------------------------------------------------------------------------

/**
 * 宿主的 `ctx.routes` 门面只有 `get/post/put/patch/delete/all`，路径支持 `:param`；
 * 而 `http/routes.ts` 是按 `app.get<{ Params… }>(path, handler)` 写的
 * （fastify 的泛型写法）。泛型运行期不存在，所以这里造一个"假 fastify"把它接住 ——
 * 换来的是那份 462 行的路由表**原样可用**，不需要为了搬家重写一遍。
 *
 * 同时补回旧服务 `setErrorHandler` 的职责：`AppError` → HTTP 状态码。
 */
function createRouteHost(routes: PluginRoutes, log: PluginLogger): FastifyInstance {
  const handle = (handler: RouteHandler): RouteHandler => {
    return async (request: any, reply: FastifyReply) => {
      // 旧服务的请求体上限是 256KB（safety/quota 的 MAX_BODY_BYTES）；
      // 宿主那条兜底路由用的是 fastify 默认值，所以这里自己兜一道。
      const declared = Number(request?.headers?.['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return reply.code(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KB）`,
          },
        });
      }
      try {
        return await handler(request, reply);
      } catch (err) {
        return sendError(reply, err, log);
      }
    };
  };

  return {
    get: (p: string, h: RouteHandler) => routes.get(p, handle(h)),
    post: (p: string, h: RouteHandler) => routes.post(p, handle(h)),
    put: (p: string, h: RouteHandler) => routes.put(p, handle(h)),
    patch: (p: string, h: RouteHandler) => routes.patch(p, handle(h)),
    delete: (p: string, h: RouteHandler) => routes.delete(p, handle(h)),
    all: (p: string, h: RouteHandler) => routes.all(p, handle(h)),
  } as unknown as FastifyInstance;
}

/** 旧服务错误响应体形状： `{ error: { code, message, details?, requestId } }` */
function sendError(reply: FastifyReply, err: unknown, log: PluginLogger): unknown {
  // SSE 已经 hijack 过的响应不能再 send（会抛"reply already sent"）
  if (reply.raw?.headersSent) {
    try {
      reply.raw.end();
    } catch {
      /* 已经断了就算了 */
    }
    return undefined;
  }

  const requestId = randomUUID();
  if (err instanceof AppError) {
    return reply.code(err.status).send({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
  }

  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 400) {
    return reply.code(400).send({
      error: { code: 'BAD_REQUEST', message: (err as Error).message, requestId },
    });
  }
  log.error?.(`未处理的服务端错误 ${requestId}: ${String(err)}`);
  return reply.code(500).send({
    error: { code: 'INTERNAL', message: (err as Error).message ?? String(err), requestId },
  });
}

// ---------------------------------------------------------------------------
// 组装（对应旧服务 main() 的第 1~6 步）
// ---------------------------------------------------------------------------

export async function apply(ctx: PluginContext, settings: PluginSettings): Promise<void> {
  const space = ctx.space.for(PACKAGE);
  const log = (msg: string) => ctx.logger?.info?.(`[${ID}] ${msg}`);
  const warn = (msg: string) => ctx.logger?.warn?.(`[${ID}] ${msg}`);

  const config = buildConfig(settings, {
    templatesDir: path.join(ASSETS_DIR, 'templates'),
    dbFile: space.resolve('anima-plus.sqlite'),
    cacheDir: space.resolve('cache'),
    dataDir: space.root,
  });

  // 1. 模板：静态校验失败直接抛 → 装配审计会把它记成"插件激活失败"，设置页可见
  const templates = new TemplateRegistry(config.templatesDir, (msg, meta) =>
    warn(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  );
  await templates.load();
  log(`模板已加载 ${templates.list().length} 个`);

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

  // 4. 依赖检查（模板需要的节点类 vs 上游 /object_info）+ 任务编排 + 缩略图缓存
  const deps = new DepsService(
    client,
    templates,
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

  const jobs = new JobManager(client, templates, {
    clientId,
    deps,
    // 并发与历史长度都来自设置项（JobManager 本来就支持注入，见其 ManagerOptions）
    maxQueueDepth: config.maxQueueDepth,
    maxJobsRetained: config.maxJobsRetained,
    log: (msg, meta) => log(`${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`),
  });
  jobs.start();
  const thumbs = new ThumbnailCache(path.join(config.cacheDir, 'loras-thumbs'), (msg, meta) =>
    ctx.logger?.debug?.(`[${ID}] [thumb] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
  );

  // 5. WeiLin 适配层（复用它在 ComfyUI 上注册的 REST 路由；不读本地库）
  const weilin = new WeilinClient({
    baseUrl: config.comfyBaseUrl,
    mode: config.comfyMode,
    log: (msg, meta) => ctx.logger?.debug?.(`[${ID}] [weilin] ${msg} ${meta ? JSON.stringify(meta) : ''}`),
  });
  const weilinStatus = await weilin.probe();
  if (weilinStatus.available) {
    log(`WeiLin 已就绪，LoRA ${weilinStatus.total} 个`);
  } else {
    warn(`WeiLin 不可用（标签/LoRA 面板降级，出图不受影响）：${weilinStatus.message}`);
  }

  // 6. 路由：内部路径与旧服务逐字一致 → 完整路径 /api/p/anima-plus/api/*
  const routes = ctx.routes.for(ID);
  await registerRoutes(createRouteHost(routes, ctx.logger ?? {}), {
    config,
    templates,
    jobs,
    client,
    weilin,
    thumbs,
    presets,
    deps,
  });

  // 自检端点：设置页/排障时一眼看到生效的地址与空间
  routes.get('/config', async () => ({
    comfyBaseUrl: config.comfyBaseUrl,
    maxQueueDepth: config.maxQueueDepth,
    maxJobsRetained: config.maxJobsRetained,
    depsWarmupOnStart: config.depsWarmupOnStart,
    depsCacheTtlMs: config.depsCacheTtlMs,
    templatesDir: config.templatesDir,
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
