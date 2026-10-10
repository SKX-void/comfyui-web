import type { FastifyInstance } from 'fastify';
import type { WorkflowDetail } from '@comfyui-web/shared';
import { narrowWorkflowBounds } from '../../safety/effective.js';
import type { RouteDeps } from './shared.js';

export function registerWorkflow(app: FastifyInstance, deps: RouteDeps): void {
  const { workflow } = deps;

  // -------------------------------------------------------------------------
  // 工作流（插件只有一份：D16/D19 之后一个工作流 = 一个 tab，没有"多模板"）
  // -------------------------------------------------------------------------

  app.get('/api/workflow', async () => {
    const tpl = workflow.get();
    // 用安全策略收窄下发的 ui.min/max（plugins/anima-plus/docs/safety.md）：
    // 前端滑块/数字框因此不会给出"填了也一定会被拒"的区间，
    // 而且改上限只需改策略一处，不用回头改 assets/form.json 里的提示值。
    const def = narrowWorkflowBounds(tpl.def, tpl.graph);
    const detail: WorkflowDetail = {
      ...def,
      graphNodeCount: Object.keys(tpl.graph).length,
    };
    return detail;
  });

  /**
   * 重新加载工作流定义（改 assets/form.json / workflow.json 后无需重启后端）。
   * 校验失败时抛错并保留原有定义，不会把服务搞坏。
   */
  app.post('/api/workflow/reload', async () => {
    const before = workflow.get().def.version;
    await workflow.load();
    return { reloaded: true, version: workflow.get().def.version, before };
  });
}
