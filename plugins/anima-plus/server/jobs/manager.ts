import { randomUUID } from 'node:crypto';
import type {
  CreateJobRequest,
  Job,
  JobEvent,
} from '@comfyui-web/shared';
import { AppError } from '../errors.js';
import type { DepsService } from '../deps.js';
import type { TriggerResolver } from '../triggers/resolve.js';
import type { ComfyClient, ComfyEvent } from '../comfy/types.js';
import type { WorkflowDefinition } from '../templates/loader.js';
import { renderTemplate } from '../templates/render.js';
import { MAX_JOBS_RETAINED, MAX_QUEUE_DEPTH } from '../safety/quota.js';
import { applyComfyEvent } from './comfy-events.js';
import { cancelJob } from './cancel.js';
import { JobEventBus } from './event-bus.js';
import { finalizeJob } from './finalize.js';
import type { ManagerOptions } from './options.js';
import { clearFinishedJobs, countInFlightJobs, evictOldJobsOverLimit } from './retention.js';
import { planFor } from './plan.js';
import { sweepJobs } from './sweep.js';

// assetId 的编解码仍从这个模块路径对外（server/http/** 从这里 import，实现见 jobs/asset-id.ts）
export { decodeAssetId, encodeAssetId } from './asset-id.js';
export type { AssetRef } from './asset-id.js';

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly promptToJob = new Map<string, string>();
  private readonly events = new JobEventBus();
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly sweepIntervalMs: number;
  private readonly staleJobMs: number;
  private readonly maxQueueDepth: number;
  private readonly maxJobsRetained: number;
  private readonly deps: DepsService;
  private readonly triggers: TriggerResolver;

  constructor(
    private readonly client: ComfyClient,
    private readonly workflow: WorkflowDefinition,
    private readonly opts: ManagerOptions,
  ) {
    this.deps = opts.deps;
    this.triggers = opts.triggers;
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

  /** 周期性对账：把非终态任务与上游 /history + /queue 对齐（原因见 jobs/sweep.ts） */
  private async sweep(): Promise<void> {
    await sweepJobs({
      jobs: this.jobs,
      client: this.client,
      staleJobMs: this.staleJobMs,
      log: this.opts.log,
      events: this.events,
      finalize: (job) => this.finalize(job),
    });
  }

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  async submit(req: CreateJobRequest): Promise<Job> {
    const tpl = this.workflow.get();
    // 触发词必须在渲染前解析：Lora堆（节点 58）不会注入，词由我们拼进 28（质量词）之前。
    // 解析失败绝不能挡住出图 —— TriggerResolver 内部已把 WeiLin 不可用降级成"没有默认词"。
    const triggerPrefix = await this.triggers.prefix((req.values ?? {}).loras);
    const { graph, values, seeds, safety } = renderTemplate(tpl, req.values ?? {}, {
      triggerPrefix,
    });

    // 安全护栏夹紧了模板自带的越界值（用户填的值越界会在这里之前就抛错）
    if (safety.clamped.length > 0) {
      this.opts.log('安全护栏夹紧了工作流自带的越界值', {
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
      workflowVersion: tpl.def.version,
      status: 'created',
      progress: null,
      values,
      seeds,
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
      // 工作流依赖的节点是否都已加载（v1-roadmap M2 验收）。
      // nodes 由 loader 从 workflow.json 推导（手写清单漂过）；检查走 DepsService 的缓存
      // （object_info 很贵，缓存策略见 server/deps.ts）。
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
              `工作流依赖的节点未加载: ${this.deps.describeMissing(missing, tpl.def.requirements)}`,
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

      this.opts.log('任务已提交', { jobId, promptId: result.promptId });
      this.emit(job, 'queued', { promptId: result.promptId, status: job.status });

      return job;
    } catch (err) {
      if (!handedOff) this.jobs.delete(jobId);
      throw err;
    }
  }

  /** 在途任务数（created / queued / running） */
  private countInFlight(): number {
    return countInFlightJobs(this.jobs);
  }

  /** 任务表按条数淘汰（规则与为什么见 jobs/retention.ts） */
  private evictOldJobs(): void {
    evictOldJobsOverLimit(this.jobs, this.promptToJob, this.maxJobsRetained, this.opts.log);
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
    return clearFinishedJobs(this.jobs, this.promptToJob, this.opts.log);
  }

  /** 订阅某任务的领域事件，返回取消订阅函数 */
  subscribe(jobId: string, handler: (evt: JobEvent) => void): () => void {
    return this.events.subscribe(jobId, handler);
  }

  /** 订阅**所有**任务的事件（队列视图一条 SSE 盯全部），返回取消订阅函数 */
  subscribeAll(handler: (job: Job, evt: JobEvent) => void): () => void {
    return this.events.subscribeAll(handler);
  }

  /** 取消一个任务（上游真相优先的细节见 jobs/cancel.ts） */
  async cancel(jobId: string): Promise<Job> {
    return cancelJob(
      {
        jobs: this.jobs,
        client: this.client,
        log: this.opts.log,
        emit: (job, data) => this.emit(job, 'canceled', data),
      },
      jobId,
    );
  }

  // -------------------------------------------------------------------------
  // 内部：ComfyUI 事件 -> 领域事件
  // -------------------------------------------------------------------------

  private emit(job: Job, type: JobEvent['type'], data: Record<string, unknown>): void {
    this.events.emit(job, type, data);
  }

  private onComfyEvent(evt: ComfyEvent): void {
    applyComfyEvent(
      {
        jobs: this.jobs,
        promptToJob: this.promptToJob,
        events: this.events,
        finalize: (job) => this.finalize(job),
        // 计划按图缓存（plan.ts）；工作流重载后 get() 换成新对象，会重算
        plan: planFor(this.workflow.get().graph),
      },
      evt,
    );
  }

  /** 终态对账：状态真相源是 ComfyUI /history，不是 WS（重试与原因见 jobs/finalize.ts） */
  private async finalize(job: Job): Promise<void> {
    await finalizeJob(
      { client: this.client, workflow: this.workflow, log: this.opts.log, events: this.events },
      job,
    );
  }
}
