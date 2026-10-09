/**
 * 路由：宿主统一加前缀 → `/api/p/image-reverse-inference/*`。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET | `/settings` | 盘上的原始值 + 本次装载生效值 |
 * | PUT | `/settings` | 写设置（整体替换，收敛在 settings.ts 一处发生） |
 * | PUT | `/params` | 把「这次用的参数」**并进**默认值（不含地址与模型；下次挂载生效） |
 * | GET | `/model` | 工作流指定的模型 + 本机装没装（插件不提供选模型） |
 * | GET | `/status` | ComfyUI 连没连上（设置页显示用） |
 * | POST | `/infer` | 上传 base64 图 → 反推 → 返回 tags |
 *
 * 图片为什么走 **base64 JSON** 而不是 multipart：宿主的 fastify 只注册了
 * `application/json` 与 `text/plain` 两个解析器，别的 content-type 在进 handler 之前
 * 就被 415 挡掉（实测 fastify 5 的 handle-request 阶段），插件拿不到原始流。
 */
import { MAX_IMAGE_BYTES } from './meta.js';
import { extractTags } from './comfy.js';
import { pickParams } from './settings.js';
import { imageInputValue, renderGraph } from './workflow.js';
import type { ComfyClient } from './comfy.js';
import type { Graph, InferResult, TaggerParams, WorkflowBindings } from './model.js';
import type { PluginRoutes, RequestBody, RouteReply } from './types.js';
import type { ResolvedSettings } from './model.js';

/** data URL 的 mime → 存到 ComfyUI 时用的扩展名 */
const ALLOWED_MIME: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

interface DecodedImage {
  bytes: Buffer;
  filename: string;
}

/** 入参不合法：抛到 handler 里统一转 400（不用"返回一个错误对象"那种要靠调用方记得检查的形状） */
class BadInput extends Error {}

function badRequest(reply: RouteReply, message: string): unknown {
  return reply.code(400).send({ error: { code: 'BAD_REQUEST', message } });
}

/** 文件名只留 URL/文件系统都安全的字符：它要进 multipart，也要进 ComfyUI 的 input/ */
function safeFilename(raw: unknown, ext: string): string {
  const source = typeof raw === 'string' ? raw : '';
  const stem = source
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 64);
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${stem === '' ? 'upload' : stem}-${unique}.${ext}`;
}

function decodeImage(body: RequestBody): DecodedImage {
  const dataUrl = body.dataUrl;
  if (typeof dataUrl !== 'string') {
    throw new BadInput('请求体必须是 { dataUrl: "data:image/webp;base64,…" }');
  }
  const matched = DATA_URL_RE.exec(dataUrl.trim());
  if (matched === null) {
    throw new BadInput('dataUrl 不是合法的 base64 data URL');
  }
  const mime = (matched[1] ?? '').toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (ext === undefined) {
    throw new BadInput(`只收 ${Object.keys(ALLOWED_MIME).join(' / ')}，收到 ${mime}`);
  }
  const bytes = Buffer.from((matched[2] ?? '').replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new BadInput('图片是空的');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new BadInput(
      `图片 ${Math.round(bytes.length / 1024)}KB 超过上限 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB（前端应先压缩）`,
    );
  }
  return { bytes, filename: safeFilename(body.filename, ext) };
}

/** 本次请求的参数 = 设置里的默认值 + 请求里的覆盖（越界的阈值收敛，不炸） */
function mergeParams(settings: ResolvedSettings, raw: unknown): TaggerParams {
  const source = raw !== null && typeof raw === 'object' ? (raw as RequestBody) : {};
  const ratio = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 1)
      : fallback;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const base = settings.values;
  return {
    threshold: ratio(source.threshold, base.threshold),
    characterThreshold: ratio(source.characterThreshold, base.characterThreshold),
    replaceUnderscore: bool(source.replaceUnderscore, base.replaceUnderscore),
    trailingComma: bool(source.trailingComma, base.trailingComma),
    excludeTags: typeof source.excludeTags === 'string' ? source.excludeTags : base.excludeTags,
  };
}

export function registerRoutes({
  routes,
  settings,
  comfy,
  workflow,
  bindings,
  log,
  state,
}: {
  routes: PluginRoutes;
  settings: ResolvedSettings;
  comfy: ComfyClient;
  workflow: Graph;
  bindings: WorkflowBindings;
  log: (msg: string) => void;
  state: { inFlight: number };
}): void {
  routes.get('/settings', async () => ({
    values: settings.stored.values,
    effective: { ...settings.values },
    file: settings.stored.file,
    ...(settings.stored.error !== undefined ? { error: settings.stored.error } : {}),
  }));

  routes.put('/settings', async (request, reply) => {
    const body = request.body;
    const incoming =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as RequestBody).values
        : undefined;
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return badRequest(reply, '请求体必须是 { values: {…} }：键与 package.json 的 plugin.settings 同名');
    }
    // 值原样落盘、**不在这里收敛**：范围与回落在 settings.ts 一处决定
    const file = settings.write(incoming);
    log(`设置已更新 ${file}（重新挂载后生效）`);
    return { values: incoming, file, reloadRequired: true };
  });

  /**
   * 「这次用的参数」写回默认值（前端在**点开始反推**时顺手调一次）。
   *
   * 与 `PUT /settings` 的两点区别都是刻意的：
   *   - 只并参数键，不碰 `comfyuiBaseUrl`（反推一次不该把地址洗掉）；
   *   - `reloadRequired: false`：本次请求的参数是前端显式送来的，运行中的 fiber
   *     不需要换默认值；落盘只是为了让**下次挂载**看到同样的值。
   */
  routes.put('/params', async (request, reply) => {
    const body =
      request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as RequestBody)
        : {};
    const incoming = body.params;
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return badRequest(reply, '请求体必须是 { params: {…} }：键与本次反推用到的参数同名');
    }
    const values = pickParams(incoming);
    const file = settings.merge(values);
    log(`本次参数已写回默认值 ${file}（下次挂载生效）`);
    return { values, file, reloadRequired: false };
  });

  /**
   * 模型是**工作流的事实**（`workflow.json` 里 tagger 节点的 `model` 输入），
   * 这里只报告它是什么、以及本机 ComfyUI 装没装 —— 换模型请重新导出工作流，
   * 插件没有「选模型」的入口（升级工作流顺带换模型是预期用法）。
   */
  routes.get('/model', async () => {
    const model = bindings.taggerModel;
    try {
      const info = await comfy.objectInfo(workflow[bindings.taggerId]?.class_type ?? 'WD14Tagger|pysssss');
      const required = (info?.input as { required?: Record<string, unknown> } | undefined)?.required;
      const modelSpec = required?.model;
      const choices = Array.isArray(modelSpec) ? modelSpec[0] : undefined;
      const known = Array.isArray(choices)
        ? choices.filter((m): m is string => typeof m === 'string')
        : [];
      // 拿不到候选列表时 installed = null（未知），别把「问不到」说成「没装」
      return { reachable: true, model, installed: known.length === 0 ? null : known.includes(model) };
    } catch (err) {
      log(`取节点信息失败（模型装没装未知）：${err instanceof Error ? err.message : String(err)}`);
      return { reachable: false, model, installed: null };
    }
  });

  routes.get('/status', async () => {
    const base = { comfyuiBaseUrl: comfy.baseUrl, inFlight: state.inFlight };
    try {
      const stats = await comfy.stats();
      return { ...base, comfyui: { reachable: true, ...stats } };
    } catch (err) {
      return {
        ...base,
        comfyui: { reachable: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  routes.post('/infer', async (request, reply) => {
    const body =
      request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as RequestBody)
        : {};

    let decoded: DecodedImage;
    try {
      decoded = decodeImage(body);
    } catch (err) {
      if (err instanceof BadInput) return badRequest(reply, err.message);
      throw err;
    }

    const params = mergeParams(settings, body.params);
    const started = Date.now();
    state.inFlight += 1;
    try {
      const uploaded = await comfy.uploadImage(decoded.bytes, decoded.filename);
      const graph = renderGraph(workflow, bindings, uploaded, params);
      const promptId = await comfy.submit(graph);
      log(`已提交反推 ${promptId}（${decoded.filename}，${imageInputValue(uploaded)}）`);

      const entry = await comfy.waitFor(promptId);
      const tags = extractTags(entry, bindings);
      if (tags === null) {
        return reply.code(502).send({
          error: { code: 'NO_TAGS', message: '工作流跑完了，但输出里没有反推文本（检查 tagger 节点是否还是输出节点）' },
        });
      }

      const result: InferResult = {
        promptId,
        tags,
        model: bindings.taggerModel,
        uploaded,
        elapsedMs: Date.now() - started,
      };
      log(`反推完成 ${promptId}：${tags.length} 字符，${result.elapsedMs}ms`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`反推失败：${message}`);
      return reply.code(502).send({ error: { code: 'COMFY_FAILED', message } });
    } finally {
      state.inFlight -= 1;
    }
  });
}
