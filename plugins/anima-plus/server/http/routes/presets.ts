import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './shared.js';

export function registerPresets(app: FastifyInstance, deps: RouteDeps): void {
  const { presets } = deps;

  // -------------------------------------------------------------------------
  // 预设（全局共用；uid 预留多用户，目前固定 'local'）
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
}
