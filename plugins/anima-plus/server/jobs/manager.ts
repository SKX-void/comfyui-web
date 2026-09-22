import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  CreateJobRequest,
  Job,
  JobAsset,
  JobEvent,
} from '@comfyui-web/shared';
import { AppError } from '../errors.js';
import type { ComfyClient, ComfyEvent } from '../comfy/types.js';
import type { DepsService } from '../deps.js';
import type { TemplateRegistry } from '../templates/loader.js';
import { renderTemplate } from '../templates/render.js';
import { MAX_JOBS_RETAINED, MAX_QUEUE_DEPTH } from '../safety/quota.js';

/** 把「产出图片」编码成可逆的 assetId，避免额外持久化 */
export function encodeAssetId(a: { type: string; subfolder: string; filename: string }): string {
  return Buffer.from(`${a.type}\u0000${a.subfolder}\u0000${a.filename}`).toString('base64url');
}

export function decodeAssetId(id: string): {
  type: string;
  subfolder: string;
  filename: string;
} {
  const raw = Buffer.from(id, 'base64url').toString('utf8');
  const [type, subfolder, filename] = raw.split('\u0000');
  if (!type || !filename) throw AppError.badRequest(`非法 assetId: ${id}`);
  return { type, subfolder: subfolder ?? '', filename };
}

interface ManagerOptions {
  /** 所有任务共用的 client_id（ComfyUI 进度只投递给提交者，见 v1-api.md §B.2） */
  clientId: string;
  /** 依赖检查服务：提交前查节点用它的缓存（object_info 约 9MB/2s） */
  deps: DepsService;
  log: (msg: string, meta?: unknown) => void;
  /** 对账周期（毫秒），默认 10s */
  sweepIntervalMs?: number;
  /** 判定"上游已丢失该任务"的静默时长（毫秒），默认 120s */
  staleJobMs?: number;
  /** 在途任务上限，默认 MAX_QUEUE_DEPTH（可注入便于测试） */
  maxQueueDepth?: number;
  /** 任务表保留条数，默认 MAX_JOBS_RETAINED（可注入便于测试） */
  maxJobsRetained?: number;
}

const TERMINAL: ReadonlySet<Job['status']> = new Set(['succeeded', 'failed', 'canceled']);

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly promptToJob = new Map<string, string>();
  private readonly bus = new EventEmitter();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly sweepIntervalMs: number;
  private readonly staleJobMs: number;
  private readonly maxQueueDepth: number;
  private readonly maxJobsRetained: number;
  private readonly deps: DepsService;

  constructor(
    private readonly client: ComfyClient,
    private readonly templates: TemplateRegistry,
    private readonly opts: ManagerOptions,
  ) {
    this.bus.setMaxListeners(0);
    this.deps = opts.deps;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 10_000;
    this.staleJobMs = opts.staleJobMs ?? 120_000;
    this.maxQueueDepth = opts.maxQueueDepth ?? MAX_QUEUE_DEPTH;
    this.maxJobsRetained = opts.maxJobsRetained ?? MAX_JOBS_RETAINED;
  }

  start(): void {
    this.unsubscribe = this.client.subscribe((evt) => this.onComfyEvent(evt));
    // 周期性对账：WS 事件可能丢失（断线/漏帧），且重启后需恢复状态
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * 对账：把非终态任务与上游 /history + /queue 对齐。
   *
   * 存在的必要性（已实测）：
   * WS 事件可能因断线或客户端 bug 丢失，此时任务会永久停在 queued/running。
   */
  private async sweep(): Promise<void> {
    const candidates = [...this.jobs.values()].filter(
      (j) => j.promptId !== null && !TERMINAL.has(j.status),
    );
    if (candidates.length === 0) return;

    let queueIds: Set<string> | null = null;
    try {
      const q = await this.client.getQueue();
      queueIds = new Set(
        [...q.running, ...q.pending]
          .map((r) => r.promptId)
          .filter((id): id is string => typeof id === 'string'),
      );
    } catch {
      // 上游不可达：本轮跳过，不误判
    }

    for (const job of candidates) {
      const promptId = job.promptId;
      if (!promptId) continue;
      try {
        const history = await this.client.getHistory(promptId);
        if (history?.completed) {
          this.opts.log('对账：任务已完成，补发终态', { jobId: job.jobId, status: job.status });
          await this.finalize(job);
          continue;
        }
        const inQueue = queueIds?.has(promptId) ?? false;
        const ageMs = Date.now() - new Date(job.startedAt ?? job.createdAt).getTime();
        if (queueIds !== null && !inQueue && !history && ageMs > this.staleJobMs) {
          job.status = 'failed';
          job.error = {
            code: 'EXECUTION_FAILED',
            message: '任务在上游既不在队列也无历史记录（可能被 ComfyUI 重启清除）',
          };
          job.finishedAt = new Date().toISOString();
          this.opts.log('对账：任务已丢失', { jobId: job.jobId, promptId });
          this.emit(job, 'error', {
            code: job.error.code,
            message: job.error.message,
          });
        }
      } catch {
        // 单次对账失败不影响其它任务
      }
    }
  }

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  async submit(req: CreateJobRequest): Promise<Job> {
    const tpl = this.templates.get(req.templateId);
    const { graph, values, safety } = renderTemplate(tpl, req.values ?? {});

    // 安全护栏夹紧了模板自带的越界值（用户填的值越界会在这里之前就抛错）
    if (safety.clamped.length > 0) {
      this.opts.log('安全护栏夹紧了模板自带的越界值', {
        templateId: tpl.def.id,
        clamped: safety.clamped.map((h) => ({
          at: `${h.at.nodeId}.inputs.${h.at.field}`,
          from: h.value,
          to: h.fixed,
          rule: h.ruleId,
        })),
      });
    }

    // 先登记再校验：这段没有 await，Node 单线程下并发提交不会都数到同一个旧值
    //（否则 5 个人能同时挤进同一个空位）。登记之后本任务即计入在途数。
    const now = new Date().toISOString();
    const jobId = `j_${randomUUID()}`;

    const job: Job = {
      jobId,
      promptId: null,
      templateId: tpl.def.id,
      templateVersion: tpl.def.version,
      status: 'created',
      progress: null,
      values,
      assets: [],
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      queuePosition: null,
    };
    this.jobs.set(jobId, job);

    const inFlight = this.countInFlight();
    if (inFlight > this.maxQueueDepth) {
      this.jobs.delete(jobId);
      this.opts.log('队列已满，拒绝提交', { inFlight: inFlight - 1, max: this.maxQueueDepth });
      throw AppError.queueFull(this.maxQueueDepth);
    }

    // 顺带按条数淘汰最旧的已终态任务（在途任务永不淘汰）
    this.evictOldJobs();

    // handedOff = 这个任务已经"交出去"（提交成功或留下了失败记录），值得留在列表里。
    // 否则说明它在任何一步失败了，必须释放占位，免得占着名额又没人清。
    let handedOff = false;
    try {
      // 模板依赖的节点是否都已加载（v1-roadmap M2 验收）。
      // nodes 由 loader 从 graph.json 推导（手写清单漂过），检查走 DepsService 的缓存
      // —— 之前每次提交都要整份拉 9MB 的 object_info。
      // 查不到（上游不可达）时**跳过检查**：下面的 submit 会给出更准确的连接错误，
      // 不能因为"检查不了"就把任务拦下。
      const required = tpl.def.requirements?.nodes ?? [];
      if (required.length > 0) {
        const keys = await this.deps
          .nodeKeys()
          .then((r) => r.keys)
          .catch(() => null);
        if (keys !== null) {
          const missing = required.filter((n) => !keys.has(n));
          if (missing.length > 0) {
            throw AppError.graphValidation(
              `模板 ${tpl.def.id} 依赖的节点未加载: ${this.deps.describeMissing(missing, tpl.def.requirements)}`,
              { missing },
            );
          }
        }
      }

      const result = await this.client.submit(graph, this.opts.clientId, {
        // 把 API 图作为额外元数据交给保存节点。
        // 键名刻意不叫 "workflow" —— 那是 ComfyUI UI 格式，前端打开会解析失败；
        // 我们只用于自己恢复参数。
        extra_pnginfo: { api_workflow: graph },
      });

      if (Object.keys(result.nodeErrors).length > 0) {
        job.status = 'failed';
        job.error = {
          code: 'GRAPH_VALIDATION_FAILED',
          message: 'ComfyUI 报告节点校验错误',
          detail: result.nodeErrors,
        };
        job.finishedAt = new Date().toISOString();
        handedOff = true;
        this.emit(job, 'error', { code: job.error.code, message: job.error.message });
        throw AppError.graphValidation('ComfyUI 报告节点校验错误', result.nodeErrors);
      }

      job.promptId = result.promptId;
      job.status = 'queued';
      this.promptToJob.set(result.promptId, jobId);
      handedOff = true;

      this.opts.log('任务已提交', { jobId, promptId: result.promptId, templateId: tpl.def.id });
      this.emit(job, 'queued', { promptId: result.promptId, status: job.status });

      return job;
    } catch (err) {
      if (!handedOff) this.jobs.delete(jobId);
      throw err;
    }
  }

  /** 在途任务数（created / queued / running） */
  private countInFlight(): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (!TERMINAL.has(j.status)) n += 1;
    }
    return n;
  }

  /**
   * 任务表按条数淘汰：超过上限时**从最旧的开始丢**（Map 保持插入顺序，
   * 也就是"从前舍弃"）。只丢已终态的任务 —— 在途任务被丢掉就意味着
   * 它永远收不到终态事件，还会一直占着队列名额。
   */
  private evictOldJobs(): void {
    if (this.jobs.size <= this.maxJobsRetained) return;
    let dropped = 0;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= this.maxJobsRetained) break;
      if (!TERMINAL.has(j.status)) continue;
      this.jobs.delete(id);
      if (j.promptId) this.promptToJob.delete(j.promptId);
      dropped += 1;
    }
    if (dropped > 0) {
      this.opts.log('任务表超出上限，已从最旧的开始淘汰', {
        dropped,
        retained: this.jobs.size,
        max: this.maxJobsRetained,
      });
    }
  }

  get(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw AppError.jobNotFound(jobId);
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 清空历史记录（前端「清空」按钮）。
   *
   * 历史本来就在内存里（不持久化），这里只是手动丢掉。
   * **只清已终态的**：在途任务的记录一删，它后面的事件就没地方落了，
   * 用户还会以为"什么都没在跑"，而 GPU 其实正忙着 —— 所以留着，并把数量回报给前端。
   */
  clearFinished(): { cleared: number; kept: number } {
    let cleared = 0;
    for (const [id, job] of this.jobs) {
      if (!TERMINAL.has(job.status)) continue;
      this.jobs.delete(id);
      if (job.promptId) this.promptToJob.delete(job.promptId);
      cleared += 1;
    }
    const kept = this.countInFlight();
    this.opts.log('已清空历史记录', { cleared, kept });
    return { cleared, kept };
  }

  /** 订阅某任务的领域事件，返回取消订阅函数 */
  subscribe(jobId: string, handler: (evt: JobEvent) => void): () => void {
    const channel = `job:${jobId}`;
    this.bus.on(channel, handler);
    return () => this.bus.off(channel, handler);
  }

  async cancel(jobId: string): Promise<Job> {
    const job = this.get(jobId);
    if (TERMINAL.has(job.status)) {
      return job;
    }
    await this.client.interrupt();
    job.status = 'canceled';
    job.finishedAt = new Date().toISOString();
    this.emit(job, 'canceled', { status: job.status });
    return job;
  }

  // -------------------------------------------------------------------------
  // 内部：ComfyUI 事件 -> 领域事件
  // -------------------------------------------------------------------------

  private emit(job: Job, type: JobEvent['type'], data: Record<string, unknown>): void {
    const evt: JobEvent = { type, data };
    this.bus.emit(`job:${job.jobId}`, evt);
  }

  private onComfyEvent(evt: ComfyEvent): void {
    const promptId = typeof evt.data.prompt_id === 'string' ? evt.data.prompt_id : null;
    if (!promptId) return;
    const jobId = this.promptToJob.get(promptId);
    if (!jobId) return; // 不属于本服务器的任务（WS 会广播部分事件）
    const job = this.jobs.get(jobId);
    if (!job) return;

    switch (evt.type) {
      case 'execution_start': {
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        this.emit(job, 'started', { status: job.status });
        break;
      }

      case 'executing': {
        const node = evt.data.node;
        if (node === null) {
          // 执行结束：以 /history 为准落最终状态（WS 只用于进度）
          void this.finalize(job);
        } else {
          this.emit(job, 'node', { node: String(node) });
        }
        break;
      }

      case 'progress': {
        const value = Number(evt.data.value ?? 0);
        const max = Number(evt.data.max ?? 0);
        job.progress = { value, max, node: (evt.data.node as string) ?? null };
        if (job.status !== 'running') {
          job.status = 'running';
        }
        this.emit(job, 'progress', { ...job.progress });
        break;
      }

      case 'progress_state': {
        // 新式多节点进度：取当前 running 节点作为主进度
        const nodes = evt.data.nodes as
          | Record<string, { value: number; max: number; state: string }>
          | undefined;
        if (!nodes) break;
        const running = Object.entries(nodes).find(([, s]) => s.state === 'running');
        if (running) {
          job.progress = { value: running[1].value, max: running[1].max, node: running[0] };
          this.emit(job, 'progress', { ...job.progress });
        }
        break;
      }

      case 'executed': {
        const output = evt.data.output as
          | { images?: Array<{ filename: string; subfolder: string; type: string }> }
          | undefined;
        for (const img of output?.images ?? []) {
          this.addAsset(job, img);
        }
        break;
      }

      case 'execution_error': {
        job.status = 'failed';
        job.error = {
          code: 'EXECUTION_FAILED',
          message:
            typeof evt.data.exception_message === 'string'
              ? evt.data.exception_message
              : '执行失败',
          node: (evt.data.node_id as string) ?? null,
          detail: evt.data.traceback,
        };
        job.finishedAt = new Date().toISOString();
        this.emit(job, 'error', {
          code: job.error.code,
          message: job.error.message,
          node: job.error.node,
        });
        break;
      }

      case 'execution_interrupted': {
        job.status = 'canceled';
        job.finishedAt = new Date().toISOString();
        this.emit(job, 'canceled', { status: job.status });
        break;
      }

      default:
        break;
    }
  }

  private addAsset(
    job: Job,
    img: { filename: string; subfolder: string; type: string },
  ): void {
    const assetId = encodeAssetId(img);
    if (job.assets.some((a) => a.assetId === assetId)) return;
    const asset: JobAsset = {
      assetId,
      url: `/api/assets/${assetId}/raw`,
      filename: img.filename,
      subfolder: img.subfolder ?? '',
      type: img.type ?? 'output',
    };
    job.assets.push(asset);
  }

  /**
   * 读取 history，带短重试。
   *
   * 必要性：`executing node=null`（结束信号）与 ComfyUI 落盘 history 之间存在竞态，
   * 首次读取可能拿到 `completed: false`。真实环境同样会有这个窗口。
   */
  private async readHistorySettled(promptId: string): Promise<Awaited<ReturnType<ComfyClient['getHistory']>>> {
    const attempts = 5;
    const delayMs = 120;
    let last = null as Awaited<ReturnType<ComfyClient['getHistory']>>;
    for (let i = 0; i < attempts; i++) {
      last = await this.client.getHistory(promptId);
      if (last?.completed) return last;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return last;
  }

  /** 终态对账：状态真相源是 ComfyUI /history，不是 WS */
  private async finalize(job: Job): Promise<void> {
    if (TERMINAL.has(job.status)) {
      return;
    }
    let completed = false;
    let historyAssets: Array<{ filename: string; subfolder: string; type: string }> = [];
    let statusStr = 'unknown';

    try {
      const history = job.promptId ? await this.readHistorySettled(job.promptId) : null;
      if (history) {
        completed = history.completed;
        statusStr = history.statusStr;
        const wanted = new Set(
          this.templates.list().find((t) => t.def.id === job.templateId)?.def.outputs.nodes ??
            [],
        );
        for (const [nodeId, output] of Object.entries(history.outputs)) {
          if (wanted.size > 0 && !wanted.has(nodeId)) continue;
          for (const img of output.images ?? []) historyAssets.push(img);
        }
        if (historyAssets.length === 0) {
          for (const output of Object.values(history.outputs)) {
            for (const img of output.images ?? []) historyAssets.push(img);
          }
        }
      }
    } catch (err) {
      this.opts.log('读取 history 失败', { jobId: job.jobId, err: String(err) });
    }

    for (const img of historyAssets) this.addAsset(job, img);

    job.finishedAt = new Date().toISOString();
    if (completed && job.assets.length > 0) {
      job.status = 'succeeded';
      this.emit(job, 'completed', {
        status: job.status,
        assets: job.assets,
        historyStatus: statusStr,
      });
    } else if (completed) {
      job.status = 'succeeded';
      this.emit(job, 'completed', { status: job.status, assets: [], historyStatus: statusStr });
    } else {
      job.status = 'failed';
      job.error = {
        code: 'EXECUTION_FAILED',
        message: `执行未成功完成 (history status: ${statusStr})`,
      };
      this.emit(job, 'error', { code: job.error.code, message: job.error.message });
    }

    this.opts.log('任务终态', { jobId: job.jobId, status: job.status, assets: job.assets.length });
  }
}
