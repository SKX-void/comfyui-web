/**
 * 已选 LoRA 的选择模型 + 每个 LoRA 的触发词三态表（用默认词 / 自定义词 / 不注入）。
 *
 * 两者放一起是因为触发词"跟着所选 LoRA 走"：选择一变就得重新解析（见 refreshResolved）。
 * 抽出来是因为 LoraSelector.vue 一份组件管三件事（选择 / 目录浏览 / 触发词），
 * 拆完每个文件都在 300 行以内。同名解构 → 模板一个字都不用改。
 *
 * 触发词解析**不在前端实现** —— 交给 /api/triggers/resolve（与提交同一个 resolver），
 * 否则界面显示迟早和真正注入的词漂移，那正是换掉全能节点前的老问题。
 * 服务端返回的明细里三态、默认词、最终词都齐了，这里只负责渲染与提交。
 */
import { ref, watch } from 'vue';
import type { LoraListItem, ResolvedTriggerWord } from '@comfyui-web/shared';
import { api } from '@/api';
import { deepClone } from '@/clone';

export interface LoraValue {
  name: string;
  lora?: string;
  weight: number;
  /** 缺省由后端补 1（前端不再暴露该权重，用户始终用默认值） */
  clipWeight?: number;
  /** 同上 */
  triggerWeight?: number;
  loraWorks?: string;
  hidden?: boolean;
}

export interface LoraSelectorProps {
  modelValue: LoraValue[];
  disabled?: boolean;
}

export function useLoraSelection(
  props: LoraSelectorProps,
  emit: (event: 'update:modelValue', value: LoraValue[]) => void,
  isDisabled: () => boolean,
) {
const selected = ref<LoraValue[]>([]);
const lastEmitted = ref('');

function sync(value: LoraValue[]): void {
  if (JSON.stringify(value) === lastEmitted.value) return;
  selected.value = deepClone(value ?? []);
}
sync(props.modelValue);
// 外部换值（载入预设等）后重算预览。不能直接写进 sync()：它在 setup 期就被调用了一次，
// 那时下面的触发词状态还没初始化（TDZ）。
watch(
  () => props.modelValue,
  (value) => {
    sync(value);
    void refreshResolved();
  },
);

function commit(): void {
  lastEmitted.value = JSON.stringify(selected.value);
  emit('update:modelValue', deepClone(selected.value));
}

function add(item: LoraListItem): void {
  if (selected.value.some((l) => l.name === item.name)) return;
  // 只带需要的字段：CLIP 权重与触发词权重固定为 1，由后端补齐
  selected.value.push({
    name: item.name,
    lora: item.lora,
    weight: 0.9,
  });
  commit();
  void refreshResolved();
}
function remove(i: number): void {
  selected.value.splice(i, 1);
  commit();
  void refreshResolved();
}
/** 权重显示成两位小数：滑动条没有刻度，值必须看得见 */
function weightText(w: number): string {
  return (Number.isFinite(w) ? w : 0).toFixed(2);
}
function setWeight(i: number, e: Event): void {
  const t = selected.value[i];
  if (!t) return;
  const v = Number((e.target as HTMLInputElement).value);
  t.weight = Number.isNaN(v) ? 0 : v;
  commit();
}
const states = ref<Record<string, ResolvedTriggerWord>>({});
/** 正在保存的 LoRA 名（防重复提交 + 置灰） */
const saving = ref<string | null>(null);
const saveError = ref<{ name: string; message: string } | null>(null);

function stateOf(name: string): ResolvedTriggerWord | undefined {
  return states.value[name];
}
/** 第 1 行：WeiLin 标签库给的默认词（可能为空） */
function defaultWordOf(name: string): string {
  return stateOf(name)?.defaultWord ?? '';
}
/** 第 1 行的开关 */
function useDefaultOf(name: string): boolean {
  return stateOf(name)?.useDefault ?? true;
}
/** 第 2 行的编辑框值 */
function customOf(name: string): string {
  return stateOf(name)?.custom ?? '';
}
/** 第 3 行：这次实际会注入的词 */
function finalWordOf(name: string): string {
  return stateOf(name)?.word ?? '';
}
function sourceLabel(name: string): string {
  const s = stateOf(name);
  if (!s) return '';
  if (s.source === 'override') return '自定义';
  if (s.source === 'weilin') return 'WeiLin 默认';
  return s.useDefault ? '无默认词' : '不注入';
}
function rowDisabled(name: string): boolean {
  return isDisabled() || saving.value === name;
}

/** 解析预览（与提交同源）。失败时清空，宁可显示不出也不假装知道 */
async function refreshResolved(): Promise<void> {
  if (selected.value.length === 0) {
    states.value = {};
    return;
  }
  try {
    const { details } = await api.resolveTriggers(selected.value);
    states.value = Object.fromEntries(details.map((d) => [d.name, d]));
  } catch {
    states.value = {};
  }
}

/**
 * 落盘：开关与编辑框都**即时保存**（没有"保存"按钮），
 * 编辑框走 `change`（失焦/回车）而不是每次按键，免得逐字符刷文件。
 */
async function saveState(name: string, useDefault: boolean, word: string): Promise<void> {
  saving.value = name;
  saveError.value = null;
  try {
    await api.setTriggerWord(name, useDefault, word.trim());
    await refreshResolved();
  } catch (err) {
    saveError.value = { name, message: (err as Error).message };
  } finally {
    saving.value = null;
  }
}

function onToggleDefault(name: string, e: Event): void {
  const useDefault = (e.target as HTMLInputElement).checked;
  // 关掉开关就立刻落盘：此时若没填词，服务端记成"不注入"（第三态）
  void saveState(name, useDefault, useDefault ? '' : customOf(name));
}
function onCustomChange(name: string, e: Event): void {
  void saveState(name, false, (e.target as HTMLInputElement).value);
}

  return {
    selected,
    sync,
    commit,
    add,
    remove,
    weightText,
    setWeight,
    states,
    saving,
    saveError,
    defaultWordOf,
    useDefaultOf,
    customOf,
    finalWordOf,
    sourceLabel,
    rowDisabled,
    onToggleDefault,
    onCustomChange,
    refreshResolved,
  };
}
