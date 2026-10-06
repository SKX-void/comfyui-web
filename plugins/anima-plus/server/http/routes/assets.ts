import type { FastifyInstance } from 'fastify';
import { decodeAssetId } from '../../jobs/manager.js';
import { makeThumbnail, normalizeThumbSize, resizerTag } from '../../weilin/thumb.js';
import type { RouteDeps } from './shared.js';

export function registerAssets(app: FastifyInstance, deps: RouteDeps): void {
  const { client, thumbs } = deps;

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
}
