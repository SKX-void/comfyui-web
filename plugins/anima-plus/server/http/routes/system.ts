import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@comfyui-web/shared';
import { AppError } from '../../errors.js';
import type { RouteDeps } from './shared.js';

export function registerSystem(app: FastifyInstance, deps: RouteDeps): void {
  const { client, config, weilin } = deps;

  // -------------------------------------------------------------------------
  // 数据源 / 系统
  // -------------------------------------------------------------------------

  app.get('/api/models', async (req) => {
    const { folder } = req.query as { folder?: string };
    if (!folder) throw AppError.badRequest('缺少 folder 参数');
    const items = await client.getModels(folder);
    return { items };
  });

  app.get('/api/system/health', async () => {
    let reachable = false;
    let version: string | undefined;
    try {
      const stats = (await client.getSystemStats()) as {
        system?: { comfyui_version?: string };
      };
      reachable = true;
      version = stats?.system?.comfyui_version;
    } catch {
      reachable = false;
    }
    const status = await weilin.probe();
    const body: HealthResponse = {
      server: 'ok',
      comfyMode: config.comfyMode,
      comfyui: { reachable, version, baseUrl: config.comfyBaseUrl },
      ws: { connected: client.isConnected() },
      weilin: {
        available: status.available,
        isLoading: status.isLoading,
        progress: status.progress,
        total: status.total,
      },
      configFiles: config.configFiles,
    };
    return body;
  });

  app.get('/api/system/stats', async () => client.getSystemStats());

  app.get('/api/system/queue', async () => client.getQueue());
}
