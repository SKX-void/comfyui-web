/**
 * 预设的前端共享状态。
 *
 * 四个输入块各自需要预设数据，但只需拉一次 —— 放在模块级响应式状态里，
 * 所有 PresetPicker 共用，避免每个组件各发一次请求。
 */
import { reactive } from 'vue';
import type { PresetKindPayload, PresetRecord } from '@comfyui-server/shared';
import { api } from '@/api';

const state = reactive({
  kinds: [] as PresetKindPayload[],
  loaded: false,
  loading: false,
  error: null as string | null,
});

export function usePresets() {
  async function load(force = false): Promise<void> {
    if (state.loaded && !force) return;
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    try {
      state.kinds = (await api.listPresets()).kinds;
      state.loaded = true;
    } catch (err) {
      state.error = (err as Error).message;
    } finally {
      state.loading = false;
    }
  }

  function kindOf(kind: string): PresetKindPayload | undefined {
    return state.kinds.find((k) => k.kind === kind);
  }

  async function save(
    kind: string,
    name: string,
    description: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    await api.savePreset(kind, name, { description, values });
    await load(true);
  }

  async function remove(kind: string, name: string): Promise<void> {
    await api.deletePreset(kind, name);
    await load(true);
  }

  return { state, load, kindOf, save, remove };
}

/**
 * 把预设的 `values` 写进表单。
 *
 * 服务端已把列名映射成 input key，这里再兜一层：
 * 只写「对应得上模板 input」的键，防止模板改了字段名后写入无效键。
 */
export function applyPreset(
  values: Record<string, unknown>,
  inputKeys: string[],
  preset: Record<string, unknown>,
): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(preset)) {
    if (!inputKeys.includes(k)) continue;
    values[k] = v;
    applied.push(k);
  }
  return applied;
}

/** 从当前表单值里抽出该类别要保存的内容（键用 input key，与服务端约定一致） */
export function extractPreset(
  values: Record<string, unknown>,
  targets: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of targets) out[k] = values[k];
  return out;
}

export type { PresetKindPayload, PresetRecord };
