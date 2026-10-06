import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './shared.js';

export function registerTriggers(app: FastifyInstance, deps: RouteDeps): void {
  const { triggers } = deps;

  // -------------------------------------------------------------------------
  // LoRA 触发词（plugins/anima-plus/docs/weilin.md §5.3 方案 B）
  //
  // Lora堆（节点 58）不注入触发词，词由本插件在提交时拼进 28（质量词）之前。
  // 这张覆盖表是"用户说了算"的那一层：命中即用；未命中回退 WeiLin 标签库；
  // 都没有就不注入。存储是 `<space>/triggers.json`，启动期已加载进内存。
  // -------------------------------------------------------------------------

  /**
   * 整张三态表（排障/运维用：前端渲染走 resolve，那里连默认词一起给）。
   * 存储是 `<space>/triggers.json`，启动期已加载进内存。
   */
  app.get('/api/triggers', async () => ({
    words: triggers.store.all(),
    suppressDefault: triggers.store.suppressedNames(),
  }));

  /**
   * 写入一个 LoRA 的三态。body: `{ name, useDefault, word }`
   *   - `useDefault=true` → 清掉记录（回到"用默认"）
   *   - `useDefault=false` + 有词 → 存自定义词
   *   - `useDefault=false` + 留空 → 记进 `suppressDefault`（什么都不注入）
   */
  app.put('/api/triggers', async (req) => {
    const body = (req.body ?? {}) as { name?: unknown; useDefault?: unknown; word?: unknown };
    const state = triggers.store.apply(body.name, body.useDefault, body.word);
    return {
      ...state,
      words: triggers.store.all(),
      suppressDefault: triggers.store.suppressedNames(),
    };
  });

  /**
   * 解析预览：**与提交走同一个 resolver**，所以界面上看到的就是真正会注入的。
   * body: { loras: LoraRef[] }
   */
  app.post('/api/triggers/resolve', async (req) => {
    const body = (req.body ?? {}) as { loras?: unknown };
    return { details: await triggers.resolver.resolve(body.loras) };
  });
}
