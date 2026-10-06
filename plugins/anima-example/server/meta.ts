/**
 * 本插件的身份，以及几个跨模块共用的小常量。
 *
 * 单独一个文件是为了**不把 `ID`/`PACKAGE` 复制到每个模块里** —— 空间按包名分配，
 * 写错一处就会读到别的插件的目录。
 */
import type { JobStatus } from './model.js';

export const ID = 'anima-example';

/** 空间按包名分配，所以这里必须写本插件的包名 */
export const PACKAGE = '@comfyui-web/anima-example';

/** 终态：到了这几个状态，作业不再有事件（收尾逻辑与前端都认它） */
export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['succeeded', 'failed', 'canceled']);

/** 产出图的对外地址（库里只存相对空间根的路径，对外一律走这个） */
export const assetUrl = (jobId: string, idx: number): string =>
  `/api/p/${ID}/assets/${jobId}/${idx}`;
