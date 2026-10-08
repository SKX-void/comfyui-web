import { computed, ref, watch } from 'vue';

import { crossCallTargets } from '../crosscall';
import type { CrossCallAvailability, CrossCallPlan, CrossCallReceipt, CrossCallTarget } from '../crosscall';

/**
 * 跨域调用的状态与流程：探测下游 → 组包（预览参数）→ 提交。
 *
 * 每个目标三件事分开做（见 crosscall/types.ts）：
 * - `probe()` 只读**宿主**清单（对方装没装、启没启），不打扰对方；
 * - `plan()` 读对方的参数基底、把输出填进描述提示词 —— 纯读，不发写请求；
 * - `submit()` 才写回对方状态并真的发起调用。
 *
 * 「不能调」只有两个来源：探测/组包说不 ok，或者本插件还没内容可发。两者都收敛到
 * `blocked` 这一句话上，按钮就禁用在这一句上。
 */
export function useCrossCall(currentText: () => string) {
  const targets = crossCallTargets;
  const selectedId = ref(targets[0]?.id ?? '');
  const target = computed<CrossCallTarget | null>(
    () => targets.find((one) => one.id === selectedId.value) ?? null,
  );

  const availability = ref<CrossCallAvailability | null>(null);
  const plan = ref<CrossCallPlan | null>(null);
  /** 不能调用的原因（人话）；空串 = 可以调 */
  const blocked = ref('');
  const busy = ref(false);
  const receipt = ref<CrossCallReceipt | null>(null);
  const error = ref('');

  /** 探测 + 组包一次：挂载时、换目标时、点「刷新」时都走这里 */
  async function refresh(): Promise<void> {
    receipt.value = null;
    error.value = '';
    plan.value = null;
    blocked.value = '';
    availability.value = null;

    const one = target.value;
    if (one === null) {
      blocked.value = '没有可用的下游插件';
      return;
    }
    const found = await one.probe();
    availability.value = found;
    if (!found.ok) {
      blocked.value = found.detail;
      return;
    }
    const result = await one.plan(currentText());
    if (!result.ok) {
      blocked.value = result.detail;
      return;
    }
    plan.value = result.plan;
  }

  async function run(): Promise<void> {
    const one = target.value;
    if (one === null || busy.value || blocked.value !== '') return;
    busy.value = true;
    error.value = '';
    receipt.value = null;
    try {
      // 提交前重新组包：界面上的摘要是加载时读的，对方那边可能刚改过参数、种子也得现抽
      const fresh = await one.plan(currentText());
      if (!fresh.ok) {
        blocked.value = fresh.detail;
        return;
      }
      plan.value = fresh.plan;
      receipt.value = await one.submit(fresh.plan);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  }

  // 输出一变就顺手预热下游（适配器内部按分钟节流）：写提示词要几分钟，只靠挂载那一次，
  // 按下「发图」时对方那份缓存可能已经过期（它的 TTL 是 5 分钟）。
  watch(currentText, () => {
    if (availability.value?.ok === true) target.value?.warm?.();
  });

  return { targets, selectedId, target, availability, plan, blocked, busy, receipt, error, refresh, run };
}
