/**
 * 整理（**手动**按钮，不再自动跑）：行内去重 + 只合并连续逗号。
 *
 * 算法在 `@/prompt-cleanup`（纯函数，smoke 直接单测）：换行、句号、大小写、
 * 行尾逗号、段内空格一律不动；已经干净的行原样返回。
 *
 * 抽出来是因为 TagSelector.vue 一份组件管三件事（输入 / 整理撤销 / 标签浏览器）。
 */
import { computed, ref } from 'vue';
import { cleanupPrompt } from '@/prompt-cleanup';

export function usePromptCleanup(modelValue: () => string, setValue: (text: string) => void) {
const cleanupStats = ref<{ dupes: number; commas: number } | null>(null);

const cleanupSummary = computed(() => {
  const s = cleanupStats.value;
  if (!s) return '';
  if (s.dupes === 0 && s.commas === 0) return '没有可整理的（无重复、无连续逗号）';
  return `已整理：删重复 ${s.dupes}、并连续逗号 ${s.commas}`;
});

/** 整理并记下快照（撤销按钮用） */
function cleanup(): void {
  const before = modelValue();
  const r = cleanupPrompt(before);
  if (r.text === before) {
    cleanupStats.value = { dupes: 0, commas: 0 };
    return;
  }
  undoStack.value.push(before);
  setValue(r.text);
  cleanupStats.value = { dupes: r.dupes, commas: r.commas };
}

/**
 * 撤销栈：每点一次整理压一份整理前的原文。
 *
 * 手打会**清空**它 —— 撤销是"回到整理前"，不是"撤销你后来的输入"；
 * 不清的话，整理后又改了半天再点撤销会把改动一起吞掉。
 */
const undoStack = ref<string[]>([]);

function undoCleanup(): void {
  const prev = undoStack.value.pop();
  if (prev === undefined) return;
  setValue(prev);
  cleanupStats.value = null;
}

  return { cleanupStats, cleanupSummary, cleanup, undoCleanup, undoStack };
}
