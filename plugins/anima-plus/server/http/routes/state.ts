import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors.js';
import type { RouteDeps } from './shared.js';

export function registerState(app: FastifyInstance, deps: RouteDeps): void {
  const { state, workflow } = deps;

  // -------------------------------------------------------------------------
  // 上次提交的出图参数（`<space>/last-state.json`）
  //
  // 语义是「**以每次按下生成按钮为准**」：前端只在提交那一刻 PUT 一次，
  // 页面加载时 GET 回填 —— 中途改表单不写盘，所以"上次的"永远是真正跑过的那一套。
  // 这是运行期状态而不是配置，所以既不进 settings.json（那五个键改完要重挂才生效），
  // 也不触发重挂：下次刷新页面读到的就是新值。
  // -------------------------------------------------------------------------

  app.get('/api/state', async () => state.read());

  app.put('/api/state', async (req) => {
    const body = req.body as { values?: unknown } | undefined;
    const incoming = body?.values;
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw AppError.badRequest('请求体必须是 { values: {…} }：键为模板 input 的 key');
    }
    // 落盘时按**当前**模板的 key 过滤：换过模板的机器上，文件里不该留着早已没有的字段
    return state.write(
      incoming as Record<string, unknown>,
      workflow.get().def.inputs.map((input) => input.key),
    );
  });
}
