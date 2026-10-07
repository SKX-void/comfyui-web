import { EventEmitter } from 'node:events';
import type { Job, JobEvent } from '@comfyui-web/shared';

/** 全局频道名。用 `job:*` 这种形状不会和 `job:${jobId}` 撞（jobId 是 `j_<uuid>`） */
const ALL_CHANNEL = 'job:*';

/**
 * 任务领域事件的广播：按 `job:${jobId}` 分频道，订阅者只收到自己那条任务的事件；
 * 另有一条 `ALL` 全局频道，给队列视图用（见下）。
 *
 * 监听器上限刻意放开：每个 SSE 连接都会订阅，数量由连接数决定，Node 默认的 10 只是噪音告警。
 */
export class JobEventBus {
  private readonly bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(0);
  }

  /** 订阅某任务的领域事件，返回取消订阅函数 */
  subscribe(jobId: string, handler: (evt: JobEvent) => void): () => void {
    const channel = `job:${jobId}`;
    this.bus.on(channel, handler);
    return () => this.bus.off(channel, handler);
  }

  /**
   * 订阅**所有**任务的事件，返回取消订阅函数。
   *
   * 队列视图必须走这条：一条 SSE 盯 N 个在途任务。
   * 不能"每个任务开一条 EventSource" —— 浏览器对同源 HTTP/1.1 只给 6 条连接，
   * 队列深度默认就是 5，占满之后缩略图/历史刷新全部排不上队。
   */
  subscribeAll(handler: (job: Job, evt: JobEvent) => void): () => void {
    this.bus.on(ALL_CHANNEL, handler);
    return () => this.bus.off(ALL_CHANNEL, handler);
  }

  emit(job: Job, type: JobEvent['type'], data: Record<string, unknown>): void {
    const evt: JobEvent = { type, data };
    this.bus.emit(`job:${job.jobId}`, evt);
    this.bus.emit(ALL_CHANNEL, job, evt);
  }
}
