/**
 * 安全护栏：任何要发去 ComfyUI 的值都先过这里。
 *
 * 单独一个文件、**导出**：契约测试直接 import 它（`scripts/contract-test.mjs`），
 * 因为"上下限只有一份"这件事必须能被断言，而不是靠读代码相信。
 */

export interface SafetyLimits {
  minSteps: number;
  maxSteps: number;
  minSide: number;
  maxSide: number;
}

/**
 * 上下限。全插件**只有这一份** —— 请求校验、设置默认值收敛、提交前的最终检查都用它。
 *
 * 为什么参考实现也要有护栏：它是"照抄一份就能用"的样板，抄走的不该是一个能把
 * 200 步 / 4096×4096 直接打到 GPU 上的裸奔版本。ComfyUI 不替你拦，显存打满就是整个队列卡死。
 * 上下限由**每个插件自己**定（核不管业务）：边长与 anima-plus 一样是 1216，
 * 步数两边都是 32 —— 数字一样是巧合，理由不同：这边直接跑原生工作流，留宽一点；
 * anima-plus 是多 LoRA 叠加，窗口跟着它自己的默认步数（20）走。
 */
export const SAFETY: SafetyLimits = {
  minSteps: 1,
  maxSteps: 32,
  minSide: 64,
  maxSide: 1216,
};

/**
 * 闸门只看节点的 `inputs`，所以这里故意收得比 `Graph` 宽 ——
 * 契约测试喂进来的就是 `{ 56: { inputs: { steps: 33 } } }` 这种最小图。
 */
export type GraphInputs = Record<string, { inputs?: Record<string, unknown> } | undefined>;

/**
 * 最后一道闸：不看请求，只看**真正要发出去的图**。
 *
 * 请求校验管得住"用户传了什么"，管不住"设置里配的默认值"、"工作流模板自带的数值"，
 * 也管不住以后有人改 `buildGraph` 时接错了线。图是唯一的事实，所以提交前照图再查一遍。
 *
 * 返回问题清单（空数组 = 通过）；调用方负责把它变成 400，而不是把越界值打到 GPU 上。
 */
export function assertGraphSafe(
  graph: GraphInputs,
  bindings: { samplerId: string; latentId: string },
  safety: SafetyLimits = SAFETY,
): string[] {
  const problems: string[] = [];
  const sampler = graph[bindings.samplerId]?.inputs ?? {};
  const latent = graph[bindings.latentId]?.inputs ?? {};

  const steps = Number(sampler.steps);
  if (!Number.isInteger(steps) || steps < safety.minSteps || steps > safety.maxSteps) {
    problems.push(`步数 ${String(sampler.steps)} 必须是 ${safety.minSteps}~${safety.maxSteps} 的整数`);
  }
  for (const [key, label] of [
    ['width', '宽度'],
    ['height', '高度'],
  ] as const) {
    const value = Number(latent[key]);
    if (!Number.isInteger(value) || value < safety.minSide || value > safety.maxSide) {
      problems.push(`${label} ${String(latent[key])} 必须是 ${safety.minSide}~${safety.maxSide} 的整数`);
    }
  }
  return problems;
}
