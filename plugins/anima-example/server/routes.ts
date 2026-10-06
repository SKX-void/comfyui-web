/**
 * 路由：框架统一加前缀 → `/api/p/anima-example/*`。
 *
 * 设置端点归插件自己（D15）：字段的**形状**在 package.json 的 plugin.settings 里，
 * 值在空间里的 settings.json —— 存完由前端请求宿主的 `POST /api/tabs/:id/reload`，
 * 让本插件重新 apply()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { TERMINAL } from './meta.js';
import { SAFETY, assertGraphSafe } from './safety.js';
import type { ComfyClient } from './comfy.js';
import type { createJobs } from './jobs.js';
import type { createParams } from './params.js';
import type { JobStore } from './store.js';
import type { OptionsPayload, PluginRoutes, RequestBody, StatusPayload } from './types.js';
import type {
  Graph,
  JobRow,
  ResolvedSettings,
  WorkflowBindings,
} from './model.js';

export function registerRoutes({
  routes,
  settings,
  store,
  jobs,
  params,
  comfy,
  bindings,
  log,
}: {
  routes: PluginRoutes;
  settings: ResolvedSettings;
  store: JobStore;
  jobs: ReturnType<typeof createJobs>;
  params: ReturnType<typeof createParams>;
  comfy: ComfyClient;
  bindings: WorkflowBindings;
  log: (msg: string) => void;
}) {
  routes.get('/settings', async () => ({
    values: settings.stored.values,
    effective: { ...settings.values },
    file: settings.stored.file,
    ...(settings.stored.error !== undefined ? { error: settings.stored.error } : {}),
  }));

  routes.put('/settings', async (request, reply) => {
    const body = request.body;
    const incoming =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as RequestBody).values
        : undefined;
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: '请求体必须是 { values: {…} }：键与 package.json 的 plugin.settings 同名',
        },
      });
    }
    // 值原样落盘、**不在这里收敛**：范围与回落在 settings.ts 一处决定（越界会记日志）
    const file = settings.write(incoming);
    log(`设置已更新 ${file}（重新挂载后生效）`);
    return { values: incoming, file, reloadRequired: true };
  });

  routes.get('/options', async () => {
    const o = await params.options();
    // limits 一起下发：前端把输入框的 min/max 直接绑上，免得用户"填完才吃 400"
    return {
      ...o,
      limits: { ...SAFETY },
      settings: { ...settings.values, comfyuiBaseUrl: settings.values.comfyuiBaseUrl },
    };
  });

  routes.get('/status', async () => {
    const out: StatusPayload = {
      comfyuiBaseUrl: comfy.baseUrl,
      wsConnected: comfy.connected,
      lastError: comfy.lastError,
      inFlight: jobs.inFlight(),
    };
    try {
      const [stats, queue] = await Promise.all([comfy.stats(), comfy.queue()]);
      out.comfyui = {
        reachable: true,
        version: stats?.system?.comfyui_version ?? null,
        device: stats?.devices?.[0]?.name ?? null,
        queue,
      };
    } catch (err) {
      out.comfyui = { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
    return out;
  });

  routes.post('/jobs', async (request, reply) => {
    let o: OptionsPayload | null;
    try {
      o = await params.options();
    } catch {
      o = null;
    }
    const { values, errors } = params.validate(request.body ?? {}, o ?? undefined);
    if (errors.length > 0) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: errors.join('；') } });

    const jobId = randomUUID();

    // 建图与最终护栏都在"登记作业"之前：越界的请求不该在历史里留一条失败作业，
    // 也不该占住内存表（真正的闸是 assertGraphSafe，见 safety.ts）。
    let graph: Graph;
    try {
      graph = params.buildGraph(values);
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'GRAPH_BUILD_FAILED', message: err instanceof Error ? err.message : String(err) },
      });
    }
    const unsafe = assertGraphSafe(graph, bindings);
    if (unsafe.length > 0) {
      return reply.code(400).send({ error: { code: 'UNSAFE_GRAPH', message: unsafe.join('；') } });
    }

    const entry = jobs.register(jobId, values, graph);

    try {
      const submitted = await comfy.prompt(entry.graph);
      if (!submitted.promptId) throw new Error('ComfyUI 没有返回 prompt_id');
      entry.job.promptId = submitted.promptId;
      jobs.trackPrompt(submitted.promptId, jobId);
      store.persist(entry.job);
      jobs.emit(entry, 'queued', { jobId, promptId: submitted.promptId, status: 'queued' });
      log(`作业 ${jobId} 已提交（prompt_id=${submitted.promptId}）`);
      return reply.code(201).send({ jobId, promptId: submitted.promptId, status: 'queued', createdAt: entry.job.createdAt });
    } catch (err) {
      entry.job.status = 'failed';
      entry.job.error = { code: 'COMFY_SUBMIT_FAILED', message: err instanceof Error ? err.message : String(err) };
      entry.job.finishedAt = new Date().toISOString();
      store.persist(entry.job);
      return reply.code(502).send({ error: entry.job.error, jobId });
    }
  });

  routes.get('/jobs', async (request) => {
    const limit = Math.min(Math.max(Number(request.query?.limit ?? settings.values.historyLimit) || 10, 1), 200);
    const rows = store.list(limit);
    const items = rows.map((row) => store.rowToJob(row)).map((job) => {
      const entry = jobs.find(job.jobId);
      return entry ? jobs.snapshot(entry.job) : job;
    });
    return { items, total: store.count() };
  });

  routes.get('/jobs/:id', async (request, reply) => {
    const entry = jobs.find(request.params.id);
    if (entry) return jobs.snapshot(entry.job);
    const row = store.get(request.params.id);
    if (row === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个任务' } });
    return store.rowToJob(row);
  });

  routes.get('/jobs/:id/events', (request, reply) => {
    const jobId = request.params.id;
    const entry = jobs.find(jobId);
    const row = entry ? null : store.get(jobId);
    if (!entry && row === undefined) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个任务' } });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (type: string, data: unknown): void => {
      raw.write(`event: ${type}\n`);
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 上面已经挡掉"既没在跑、库里也没有"的情况，所以这里 row 一定有
    const job = entry ? entry.job : store.rowToJob(row as JobRow);
    send('snapshot', jobs.snapshot(job));
    if (!entry || TERMINAL.has(job.status)) {
      raw.end();
      return;
    }

    const onEvent = (type: string, data: unknown): void => {
      send(type, data);
      if (type === 'completed' || type === 'error' || type === 'canceled') raw.end();
    };
    entry.listeners.add(onEvent);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(ping);
      entry.listeners.delete(onEvent);
    });
  });

  routes.post('/jobs/:id/cancel', async (request, reply) => {
    const entry = jobs.find(request.params.id);
    if (!entry) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这个任务' } });
    if (TERMINAL.has(entry.job.status)) return { ok: true, status: entry.job.status };

    try {
      if (entry.job.status === 'queued' && entry.job.promptId) {
        // 还没开跑：从 ComfyUI 队列里删掉
        await comfy.deleteQueued(entry.job.promptId).catch(() => comfy.interrupt());
      } else {
        await comfy.interrupt();
      }
    } catch (err) {
      return reply.code(502).send({ error: { code: 'CANCEL_FAILED', message: String(err) } });
    }
    // 真正的状态翻转交给 execution_interrupted；这里兜底
    jobs.cancelFallback(entry);
    return { ok: true };
  });

  routes.delete('/jobs', async () => {
    // 只清记录，不动空间里的图片（那是用户资产）。
    // 真外键 + ON DELETE CASCADE：删 jobs 一张表就够，assets 自己跟着走。
    const cleared = store.clear();
    jobs.forgetAll();
    return { cleared };
  });

  routes.get('/assets/:jobId/:idx', async (request, reply) => {
    const row = store.asset(request.params.jobId, Number(request.params.idx));
    if (row === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有这张图' } });
    // 库里是相对路径 → 交给空间句柄解析（顺带挡掉越界值）
    const file = store.resolveImage(row.file);
    if (!fs.existsSync(file)) return reply.code(410).send({ error: { code: 'GONE', message: '文件已不在磁盘上' } });
    reply.header('Content-Type', String(row.mime));
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    if (request.query?.download === '1') {
      reply.header('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
    }
    return reply.send(fs.createReadStream(file));
  });
}
