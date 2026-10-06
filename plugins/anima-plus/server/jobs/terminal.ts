import type { Job } from '@comfyui-web/shared';

/** 终态：到这三个状态后任务不再变化，保留/淘汰逻辑都据此判断 */
export const TERMINAL: ReadonlySet<Job['status']> = new Set(['succeeded', 'failed', 'canceled']);
