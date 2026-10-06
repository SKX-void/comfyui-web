import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './shared.js';

export function registerDeps(app: FastifyInstance, deps: RouteDeps): void {
  const { deps: depsService } = deps;

  // -------------------------------------------------------------------------
  // 依赖（模板需要的节点类，这台 ComfyUI 有没有）
  // -------------------------------------------------------------------------
  // 判据是 /object_info 的键集合；带 `?refresh=1` 绕过缓存（界面上"重新检查"用）。
  // 上游不可达时返回 ok:null —— 三态是刻意的，别把"连不上"说成"缺依赖"。
  app.get<{ Querystring: { refresh?: string } }>('/api/deps', async (request) =>
    depsService.report({ refresh: request.query.refresh === '1' }),
  );
}
