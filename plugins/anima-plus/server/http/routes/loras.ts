import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors.js';
import { browseLoras } from '../../weilin/browse.js';
import {
  makeThumbnail,
  normalizeThumbSize,
  resizerTag,
  sniffContentType,
  thumbStatus,
} from '../../weilin/thumb.js';
import type { RouteDeps } from './shared.js';

export function registerLoras(app: FastifyInstance, deps: RouteDeps): void {
  const { thumbs, weilin } = deps;

  // -------------------------------------------------------------------------
  // WeiLin 数据源（docs/archive/v1-api.md §A.2 / plugins/anima-plus/docs/weilin.md §7）
  //
  // 体积约束：get_lora_list(41MB) 与 lorainfo/info(71KB/条) 绝不整体下发。
  // -------------------------------------------------------------------------

  /**
   * LoRA 目录浏览（docs/archive/v1-api.md §A.2）。
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
}
