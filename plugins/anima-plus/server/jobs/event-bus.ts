import { EventEmitter } from 'node:events';
import type { Job, JobEvent } from '@comfyui-web/shared';

/**
 * 任务领域事件的广播：按 `job:${jobId}` 分频道，订阅者只收到自己那条任务的事件。
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

  emit(job: Job, type: JobEvent['type'], data: Record<string, unknown>): void {
    const evt: JobEvent = { type, data };
    this.bus.emit(`job:${job.jobId}`, evt);
  }
}
