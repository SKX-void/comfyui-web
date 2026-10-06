/**
 * 依赖检查：模板声明的节点类，这台 ComfyUI 到底有没有。
 *
 * 抽出来是因为 App.vue 是装配根：状态与流程按主题分组，根上只留接线。
 */
import { computed, ref } from 'vue';
import type { DepsReport } from '@comfyui-web/shared';
import { api } from '@/api';

export function useDependencies(pushLog: (line: string) => void) {
/** 依赖检查结果；null = 还没查过 */
const deps = ref<DepsReport | null>(null);

const depsChecking = ref(false);

/** 当前工作流的依赖结论；查不了时为 null */
const currentDeps = computed(() => deps.value?.workflow ?? null);

/** 只在**确实缺**的时候拦提交；"没查成"不拦 */
const depsReady = computed(() => currentDeps.value?.ready ?? true);

/** 有真问题（缺节点 / 没查成）时提示条自己冒出来 */
const showDepsProblem = computed(
  () =>
    deps.value !== null &&
    (deps.value.ok === null || (currentDeps.value?.missing.length ?? 0) > 0),
);

/**
 * 查依赖：模板声明的节点类，这台 ComfyUI 到底有没有。
 *
 * 失败**不影响任何操作**：记成 ok:null（"没查成"）而不是"缺依赖" ——
 * 把连不上当成缺依赖，会把用户引去装一堆本来就在的包。
 */
async function checkDeps(refresh = false): Promise<void> {
  depsChecking.value = true;
  try {
    deps.value = await api.deps(refresh);
    const missing = currentDeps.value?.missing ?? [];
    if (missing.length > 0) {
      pushLog(`依赖：当前工作流缺 ${missing.length} 个节点 —— ${missing.join('、')}`);
    } else if (deps.value.ok === null) {
      pushLog(`依赖检查未完成（ComfyUI 不可达）：${deps.value.error ?? ''}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.value = {
      ok: null,
      checkedAt: null,
      error: message,
      missingBuiltin: [],
      missing: [],
      packs: [],
      workflow: { id: '', name: '', ready: true, missing: [] },
    };
    pushLog(`依赖检查失败: ${message}`);
  } finally {
    depsChecking.value = false;
  }
}

  return { deps, depsChecking, currentDeps, depsReady, showDepsProblem, checkDeps };
}
