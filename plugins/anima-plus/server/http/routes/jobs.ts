import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CreateJobRequest, JobEvent } from '@comfyui-web/shared';
import { AppError } from '../../errors.js';
import { SSE_HEARTBEAT_MS, type RouteDeps } from './shared.js';

export function registerJobs(app: FastifyInstance, deps: RouteDeps): void {
  const { jobs } = deps;

  // -------------------------------------------------------------------------
  // 任务
  // -------------------------------------------------------------------------

  app.post('/api/jobs', async (req, reply) => {
    const body = req.body as CreateJobRequest | undefined;
    if (!body || typeof body !== 'object') {
      throw AppError.badRequest('请求体必须是 JSON 对象');
    }
    // 请求体里没有 templateId：一个插件只有一份工作流定义（D16/D19 之后没有"多模板"）
    const job = await jobs.submit({
      values: body.values ?? {},
      options: body.options,
    });
    reply.code(202);
    return {
      jobId: job.jobId,
      promptId: job.promptId,
      status: job.status,
      queuePosition: job.queuePosition ?? null,
      createdAt: job.createdAt,
    };
  });

  app.get('/api/jobs', async () => ({ items: jobs.list() }));

  /**
   * 清空历史记录（前端「清空」按钮）。
   *
   * 只清已终态的任务；在途任务保留（见 JobManager.clearFinished）。
   * 顺带把清空后的列表回给前端，省一次往返。
   */
  app.delete('/api/jobs', async () => {
    const { cleared, kept } = jobs.clearFinished();
    return { ok: true, cleared, kept, items: jobs.list() };
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return jobs.get(id);
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return jobs.cancel(id);
  });

  /**
   * SSE 事件流（docs/archive/v1-api.md §A.3）。
   * 连接即发 snapshot，断线重连可恢复，无需回放。
   */
  app.get('/api/jobs/:id/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id); // 不存在则抛 404

    // 搬进插件后新增的一行：宿主只用**一条**兜底路由 `/api/p/*` 接住所有插件的请求，
    // 所以这里显式 hijack，告诉 fastify「这个响应我自己写」。
    // （旧服务是直连 fastify 注册的，靠"handler 返回 reply 对象"就够了；多一层转发后
    //   这个隐式约定不够明确，anima-example 的 SSE 也是这么写的。）
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (evt: JobEvent): void => {
      reply.raw.write(`event: ${evt.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    };

    send({
      type: 'snapshot',
      data: {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        assets: job.assets,
        error: job.error,
      },
    });

    // 已终态：发完即关
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
      reply.raw.end();
      return reply;
    }

    const unsubscribe = jobs.subscribe(job.jobId, (evt) => {
      send(evt);
      if (evt.type === 'completed' || evt.type === 'error' || evt.type === 'canceled') {
        cleanup();
        reply.raw.end();
      }
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);

    function cleanup(): void {
      clearInterval(heartbeat);
      unsubscribe();
    }

    req.raw.on('close', cleanup);
    return reply;
  });
}
