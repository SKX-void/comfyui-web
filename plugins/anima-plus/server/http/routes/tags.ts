import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors.js';
import type { RouteDeps } from './shared.js';

export function registerTags(app: FastifyInstance, deps: RouteDeps): void {
  const { weilin } = deps;

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
}
