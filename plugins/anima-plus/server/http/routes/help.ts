import type { FastifyInstance } from 'fastify';
import { readHelpDoc } from '../../help.js';
import type { RouteDeps } from './shared.js';

export function registerHelp(app: FastifyInstance, deps: RouteDeps): void {
  // 帮助：包内 readme.md 的原文。读不到不算错误（text:null + 原因），界面自己降级
  app.get('/api/help', async () => readHelpDoc());
}
