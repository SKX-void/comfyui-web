import { animaPlus } from './anima-plus';
import type { CrossCallTarget } from './types';

/**
 * 可跨域调用的下游插件清单。今天只有 anima-plus 一个；加第二个就在这儿加一行，
 * 面板的下拉框自己会长出来（只有一个目标时退化成一行静态名字）。
 */
export const crossCallTargets: CrossCallTarget[] = [animaPlus];

export type {
  CrossCallAvailability,
  CrossCallParam,
  CrossCallPlan,
  CrossCallPlanResult,
  CrossCallReceipt,
  CrossCallTarget,
} from './types';
