import type { FastifyInstance } from 'fastify';
import { registerAssets } from './routes/assets.js';
import { registerDeps } from './routes/deps.js';
import { registerHelp } from './routes/help.js';
import { registerJobs } from './routes/jobs.js';
import { registerLoras } from './routes/loras.js';
import { registerPresets } from './routes/presets.js';
import { registerState } from './routes/state.js';
import { registerSystem } from './routes/system.js';
import { registerTags } from './routes/tags.js';
import { registerWorkflow } from './routes/workflow.js';
import { registerTriggers } from './routes/triggers.js';
import type { RouteDeps } from './routes/shared.js';

export type { RouteDeps } from './routes/shared.js';

/**
 * 薄装配层：`server/index.ts` 只认这个入口，各域实现见 `./routes/*.ts`。
 * 注册顺序与拆分前一致（各路由路径互不重叠，顺序不影响匹配）。
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  registerWorkflow(app, deps);
  registerJobs(app, deps);
  registerPresets(app, deps);
  registerState(app, deps);
  registerTriggers(app, deps);
  registerAssets(app, deps);
  registerSystem(app, deps);
  registerLoras(app, deps);
  registerTags(app, deps);
  registerDeps(app, deps);
  registerHelp(app, deps);
}
