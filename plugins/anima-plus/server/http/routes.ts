import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type CreateJobRequest,
  type HealthResponse,
  type JobEvent,
  type TemplateDetail,
} from '@comfyui-web/shared';
import { AppError } from '../errors.js';
import type { JobManager } from '../jobs/manager.js';
import { decodeAssetId } from '../jobs/manager.js';
import type { TemplateRegistry } from '../templates/loader.js';
import type { ComfyClient } from '../comfy/types.js';
import type { WeilinClient } from '../weilin/client.js';
import type { PresetStore } from '../store/presets.js';
import { browseLoras } from '../weilin/browse.js';
import {
  makeThumbnail,
  normalizeThumbSize,
  resizerTag,
  sniffContentType,
  thumbStatus,
  type ThumbnailCache,
} from '../weilin/thumb.js';
import type { ServerConfig } from '../config.js';
import type { DepsService } from '../deps.js';
import { readHelpDoc } from '../help.js';
import { narrowTemplateBounds } from '../safety/limits.js';

export interface RouteDeps {
  config: ServerConfig;
  deps: DepsService;
  templates: TemplateRegistry;
  jobs: JobManager;
  client: ComfyClient;
  weilin: WeilinClient;
  thumbs: ThumbnailCache;
  presets: PresetStore;
}

const SSE_HEARTBEAT_MS = 15_000;

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { templates, jobs, client, config, weilin, thumbs, presets, deps: depsService } = deps;

  // -------------------------------------------------------------------------
  // 模板
  // -------------------------------------------------------------------------

  app.get('/api/templates', async () => ({
    items: templates.list().map((t) => ({
      id: t.def.id,
      name: t.def.name,
      description: t.def.description ?? '',
      version: t.def.version,
    })),
  }));

  app.get('/api/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    const tpl = templates.get(id);
    // 用安全策略收窄下发的 ui.min/max（v1-safety.md）：
    // 前端滑块/数字框因此不会给出"填了也一定会被拒"的区间，
    // 而且改上限只需改策略一处，不用回头改 template.json 里的提示值。
    const def = narrowTemplateBounds(tpl.def, tpl.graph);
    const detail: TemplateDetail = {
      ...def,
      graphNodeCount: Object.keys(tpl.graph).length,
    };
    return detail;
  });

  /**
   * 重新加载模板目录（改 template.json 后无需重启后端）。
   * 校验失败时抛错并保留原有模板，不会把服务搞坏。
   */
  app.post('/api/templates/reload', async () => {
    const before = templates.list().map((t) => t.def.id);
    await templates.load();
    const after = templates.list().map((t) => t.def.id);
    return { reloaded: true, templates: after, before };
  });

  // -------------------------------------------------------------------------
  // 任务
  // -------------------------------------------------------------------------

  app.post('/api/jobs', async (req, reply) => {
    const body = req.body as CreateJobRequest | undefined;
    if (!body || typeof body !== 'object') {
      throw AppError.badRequest('请求体必须是 JSON 对象');
    }
    if (!body.templateId) {
      throw AppError.badRequest('缺少 templateId');
    }
    const job = await jobs.submit({
      templateId: body.templateId,
      values: body.values ?? {},
      options: body.options,
    });
    reply.code(202);
    return {
      jobId: job.jobId,
      promptId: job.promptId,
      status: job.status,
      queuePosition: job.queuePosition ?? null,
      createdAt: job.createdAt,
    };
  });

  app.get('/api/jobs', async () => ({ items: jobs.list() }));

  /**
   * 清空历史记录（前端「清空」按钮）。
   *
   * 只清已终态的任务；在途任务保留（见 JobManager.clearFinished）。
   * 顺带把清空后的列表回给前端，省一次往返。
   */
  app.delete('/api/jobs', async () => {
    const { cleared, kept } = jobs.clearFinished();
    return { ok: true, cleared, kept, items: jobs.list() };
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return jobs.get(id);
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return jobs.cancel(id);
  });

  /**
   * SSE 事件流（v1-api.md §A.3）。
   * 连接即发 snapshot，断线重连可恢复，无需回放。
   */
  app.get('/api/jobs/:id/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id); // 不存在则抛 404

    // 搬进插件后新增的一行：宿主只用**一条**兜底路由 `/api/p/*` 接住所有插件的请求，
    // 所以这里显式 hijack，告诉 fastify「这个响应我自己写」。
    // （旧服务是直连 fastify 注册的，靠"handler 返回 reply 对象"就够了；多一层转发后
    //   这个隐式约定不够明确，anima-example 的 SSE 也是这么写的。）
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (evt: JobEvent): void => {
      reply.raw.write(`event: ${evt.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    };

    send({
      type: 'snapshot',
      data: {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        assets: job.assets,
        error: job.error,
      },
    });

    // 已终态：发完即关
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
      reply.raw.end();
      return reply;
    }

    const unsubscribe = jobs.subscribe(job.jobId, (evt) => {
      send(evt);
      if (evt.type === 'completed' || evt.type === 'error' || evt.type === 'canceled') {
        cleanup();
        reply.raw.end();
      }
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);

    function cleanup(): void {
      clearInterval(heartbeat);
      unsubscribe();
    }

    req.raw.on('close', cleanup);
    return reply;
  });

  // -------------------------------------------------------------------------
  // 预设（全局共用；uid 预留多用户，v1 固定 'local'）
  //
  // 每种预设一张表、类型化列。响应额外带一个由列**派生**的 `values`
  // （键为模板 input 的 key），前端据此直接 Object.assign 到表单值。
  // -------------------------------------------------------------------------

  /** 全部类别一次拉齐（dialog 需要字段元数据来展示详细内容） */
  app.get('/api/presets', async () => ({ kinds: presets.listAll() }));

  app.get('/api/presets/:kind', async (req) => presets.list((req.params as { kind: string }).kind));

  /** 新增或覆盖。body: { description?, values: {...} } */
  app.put('/api/presets/:kind/:name', async (req) => {
    const { kind, name } = req.params as { kind: string; name: string };
    presets.upsert(kind, name, req.body);
    return { ok: true, kind, name };
  });

  app.delete('/api/presets/:kind/:name', async (req, reply) => {
    const { kind, name } = req.params as { kind: string; name: string };
    if (!presets.remove(kind, name)) {
      reply.code(404);
      return { ok: false, error: '预设不存在' };
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // 资源
  // -------------------------------------------------------------------------

  /**
   * 产出图（服务端缓存）。
   *
   * 经过 SaveImagePlus（WEBP q80）后单张约 100 KB；这里再加一层磁盘缓存，
   * 避免同一张图被反复从 ComfyUI 拉取（/view 不支持条件请求）。
   */
  app.get('/api/assets/:assetId/raw', async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const params = decodeAssetId(assetId);
    const result = await thumbs.getOrCreate(`asset:${assetId}`, async () => {
      const { data, contentType } = await client.fetchImage(params);
      return { data, contentType };
    });
    if (!result) {
      reply.code(404);
      return reply.send();
    }
    reply.header('Content-Type', result.contentType);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(result.data);
  });

  /**
   * 产出图缩略图（列表/画廊用）。
   *
   * 产出图是 ComfyUI 的 PNG（1~2MB），转成 ~30KB 的 JPEG 后列表才轻快；
   * 源本来就小、或尺寸离目标不远时直接透传（阈值见 weilin/thumb-codec.ts）。
   */
  app.get('/api/assets/:assetId/thumb', async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const { w, h } = req.query as { w?: string; h?: string };
    const { width, height } = normalizeThumbSize(w, h);
    const params = decodeAssetId(assetId);

    const tag = await resizerTag();
    const result = await thumbs.getOrCreate(
      `asset-thumb:${assetId}:${width}x${height}:${tag}`,
      async () => {
        const { data, contentType } = await client.fetchImage(params);
        const thumb = await makeThumbnail(data, width, height);
        return thumb ? { data: thumb, contentType: 'image/jpeg' } : { data, contentType };
      },
    );

    if (!result) {
      reply.code(204);
      return reply.send();
    }
    reply.header('Content-Type', result.contentType);
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    return reply.send(result.data);
  });

  // -------------------------------------------------------------------------
  // 数据源 / 系统
  // -------------------------------------------------------------------------

  app.get('/api/models', async (req) => {
    const { folder } = req.query as { folder?: string };
    if (!folder) throw AppError.badRequest('缺少 folder 参数');
    const items = await client.getModels(folder);
    return { items };
  });

  // -------------------------------------------------------------------------
  // WeiLin 数据源（v1-api.md §A.2 / v1-weilin.md §7）
  //
  // 体积约束：get_lora_list(41MB) 与 lorainfo/info(71KB/条) 绝不整体下发。
  // -------------------------------------------------------------------------

  /**
   * LoRA 目录浏览（v1-api.md §A.2）。
   *
   * 语义：**只返回指定目录的直属内容**，不递归子目录。
   * 子目录以 folders 形式返回，由前端逐层进入。
   * path 省略或为空表示根目录。
   */
  app.get('/api/loras/browse', async (req) => {
    const { path: rawPath } = req.query as { path?: string };
    const all = await weilin.listLoras();
    return browseLoras(all, rawPath ?? '');
  });

  /** LoRA 详情（触发词、预览图）——按需查，单条 71KB */
  app.get('/api/loras/meta', async (req) => {
    const { file } = req.query as { file?: string };
    if (!file) throw AppError.badRequest('缺少 file 参数');
    try {
      return await weilin.getLoraInfo(file);
    } catch (err) {
      throw new AppError('WEILIN_UNAVAILABLE', `读取 LoRA 详情失败: ${String(err)}`, 503);
    }
  });

  /**
   * LoRA 预览图（服务端缓存；有缩放能力时顺带缩略）。
   *
   * 实测：这台库里的预览图**已经**被离线脚本缩成 20~30KB 的 WebP，
   * 所以 3:4 卡片那种尺寸走透传、零 CPU；真要转的是新加的 LoRA（几 MB 的 PNG）。
   * 引擎、阈值、排障见 weilin/thumb-codec.ts 与 /api/loras/thumb/stats。
   *
   * 无预览图的 LoRA 返回 **204**。
   */
  app.get('/api/loras/thumb', async (req, reply) => {
    const { file, w, h } = req.query as { file?: string; w?: string; h?: string };
    if (!file) throw AppError.badRequest('缺少 file 参数');
    const { width, height } = normalizeThumbSize(w, h);

    const tag = await resizerTag();
    const result = await thumbs.getOrCreate(`lora:${file}:${width}x${height}:${tag}`, async () => {
      const raw = await weilin.fetchLoraPreview(file);
      if (!raw) return null;
      const thumb = await makeThumbnail(raw.data, width, height);
      if (thumb) return { data: thumb, contentType: 'image/jpeg' };
      // 缩放不可用/失败 → 原图直出（仍然缓存，避免反复回源）
      return {
        data: raw.data,
        contentType: sniffContentType(raw.data, raw.contentType),
      };
    });

    if (!result) {
      reply.code(204);
      return reply.send();
    }
    reply.header('Content-Type', result.contentType);
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    return reply.send(result.data);
  });

  /** 预览图缓存状态（排障用） */
  app.get('/api/loras/thumb/stats', async () => {
    const stats = await thumbs.stats();
    return { ...stats, ...thumbStatus() };
  });

  /** 标签分组列表（顶层组 + 子组，含计数） */
  app.get('/api/tags/groups', async () => {
    if (!weilin.isAvailable()) {
      throw new AppError('WEILIN_UNAVAILABLE', 'WeiLin 不可用，标签库暂不可用', 503);
    }
    const { groups } = await weilin.getTagTree();
    return { items: groups };
  });

  /** 标签检索：服务端在缓存的标签树上过滤 + 分页（前端只拿小响应） */
  app.get('/api/tags', async (req) => {
    if (!weilin.isAvailable()) {
      throw new AppError('WEILIN_UNAVAILABLE', 'WeiLin 不可用，标签库暂不可用', 503);
    }
    const { q, groupId, page, pageSize } = req.query as Record<string, string | undefined>;
    const p = Math.max(1, Number(page ?? 1) || 1);
    const size = Math.min(200, Math.max(1, Number(pageSize ?? 50) || 50));

    const { tags, groups } = await weilin.getTagTree();
    let filtered = tags;
    if (groupId) {
      const gid = Number(groupId);
      const top = groups.find((g) => g.id === gid);
      const sub = groups.flatMap((g) => g.subgroups).find((s) => s.id === gid);
      if (top) {
        filtered = filtered.filter((t) => t.topGroup === top.name);
      } else if (sub) {
        filtered = filtered.filter((t) => t.group === sub.name);
      }
    }
    if (q?.trim()) {
      const k = q.trim().toLowerCase();
      filtered = filtered.filter(
        (t) => t.text.toLowerCase().includes(k) || t.translate.includes(q.trim()),
      );
    }
    const total = filtered.length;
    return {
      items: filtered.slice((p - 1) * size, p * size),
      total,
      page: p,
      pageSize: size,
    };
  });

  /** 输入补全（轻量，不缓存） */
  app.get('/api/tags/autocomplete', async (req) => {
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { items: [] };
    if (!weilin.isAvailable()) return { items: [] };
    try {
      return { items: await weilin.autocomplete(q.trim()) };
    } catch {
      return { items: [] };
    }
  });

  /** 中英翻译 */
  app.post('/api/tags/translate', async (req) => {
    const body = req.body as { texts?: string[]; text?: string } | undefined;
    const texts = body?.texts ?? (body?.text ? [body.text] : []);
    if (texts.length === 0) throw AppError.badRequest('缺少 text 或 texts');
    const items = [];
    for (const t of texts.slice(0, 50)) {
      try {
        items.push(await weilin.translate(t));
      } catch {
        items.push({ original: t, translated: '', color: '' });
      }
    }
    return { items };
  });

  // -------------------------------------------------------------------------
  // 依赖（模板需要的节点类，这台 ComfyUI 有没有）
  // -------------------------------------------------------------------------
  // 判据是 /object_info 的键集合；带 `?refresh=1` 绕过缓存（界面上"重新检查"用）。
  // 上游不可达时返回 ok:null —— 三态是刻意的，别把"连不上"说成"缺依赖"。
  app.get<{ Querystring: { refresh?: string } }>('/api/deps', async (request) =>
    depsService.report({ refresh: request.query.refresh === '1' }),
  );

  // 帮助：包内 readme.md 的原文。读不到不算错误（text:null + 原因），界面自己降级
  app.get('/api/help', async () => readHelpDoc());

  app.get('/api/system/health', async () => {
    let reachable = false;
    let version: string | undefined;
    try {
      const stats = (await client.getSystemStats()) as {
        system?: { comfyui_version?: string };
      };
      reachable = true;
      version = stats?.system?.comfyui_version;
    } catch {
      reachable = false;
    }
    const status = await weilin.probe();
    const body: HealthResponse = {
      server: 'ok',
      comfyMode: config.comfyMode,
      comfyui: { reachable, version, baseUrl: config.comfyBaseUrl },
      ws: { connected: client.isConnected() },
      weilin: {
        available: status.available,
        isLoading: status.isLoading,
        progress: status.progress,
        total: status.total,
      },
      configFiles: config.configFiles,
    };
    return body;
  });

  app.get('/api/system/stats', async () => client.getSystemStats());

  app.get('/api/system/queue', async () => client.getQueue());
}
