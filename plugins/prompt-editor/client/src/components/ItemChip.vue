<script setup lang="ts">
/**
 * 一个条目（tag 块 / 句子块）的上格：单击改名、双击禁用。
 * 下格（译文）在 ItemTranslationCell —— 两格共享同一个 item，各管各的编辑态。
 *
 * 拖动不在这里做：组件不声明 drag* 事件，父级的 `@dragstart` 等会**透传到根元素**上，
 * 索引与落点由父级掌握（条目能拖到**别的块**去，状态留在这一层就没法跨块了）。
 */
import { nextTick, ref, watch } from 'vue';

import ItemTranslationCell from './ItemTranslationCell.vue';
import type { Item, Mode } from '../model';

const props = defineProps<{ item: Item; mode: Mode; dragging: boolean; busy: boolean; failed: boolean }>();
const emit = defineEmits<{
  (e: 'commit', text: string): void;
  (e: 'toggle'): void;
  (e: 'remove'): void;
  (e: 'translate'): void;
  /** 译文格改完了：条目变了 → 上层发"这个组编辑完了"那个草稿事件 */
  (e: 'commit-translation'): void;
  /** 点「机」标记：把机器翻的这条存进词库 */
  (e: 'promote'): void;
  /** 触屏换位：这一条在块内 +1/-1（拖拽在触摸屏上不触发） */
  (e: 'move', delta: number): void;
}>();

const editing = ref(false);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function startEdit(): void {
  if (editing.value) return;
  draft.value = props.item.text;
  editing.value = true;
}

watch(editing, async (value) => {
  if (!value) return;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
});

function commit(): void {
  if (!editing.value) return;
  // **读输入框的实时值，不能只读 draft**：v-model 在输入法组字期间不更新
  // （Vue 的 vModelText 里 `if (e.target.composing) return`），而中文输入法敲回车往往就是
  // 提交组字那一下 —— keydown 早于 compositionend，此刻 draft 还是旧文本，改名会被吞掉。
  const next = (inputEl.value?.value ?? draft.value).trim();
  editing.value = false;
  if (next !== props.item.text) emit('commit', next);
}

function cancel(): void {
  editing.value = false;
}

/** 双击禁用/启用：顺手退出编辑态，免得"刚点开的输入框"和禁用态叠在一起 */
function toggle(): void {
  editing.value = false;
  emit('toggle');
}
</script>

<template>
  <!-- 一个条目 = 上下两个小格子：上格原文，下格译文（结构固定，空译文也占位） -->
  <div class="pe-chip-cell">
    <span
      class="pe-chip"
      :class="{ 'pe-chip-off': !item.enabled, 'pe-chip-dragging': dragging }"
      :draggable="!editing"
      title="单击改名 · 双击禁用 · 可拖动排序"
      @click="startEdit"
      @dblclick.stop="toggle"
    >
      <input
        v-if="editing"
        ref="inputEl"
        v-model="draft"
        class="pe-chip-input"
        @click.stop
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      />
      <span v-else class="pe-chip-text">{{ item.text }}</span>

      <!--
        触屏（hover: none）：双击禁用、拖动排序在这里都不成立，所以换成明摆着的按钮。
        宽屏上藏起来 —— 那儿双击和拖拽更顺手，多一排按钮只是噪音。
      -->
      <span class="pe-chip-tools">
        <button
          class="pe-chip-tool"
          :title="item.enabled ? '禁用这一条（不进输出）' : '启用这一条'"
          @click.stop="toggle"
        >
          {{ item.enabled ? '禁' : '启' }}
        </button>
        <button class="pe-chip-tool" title="上移" @click.stop="emit('move', -1)">↑</button>
        <button class="pe-chip-tool" title="下移" @click.stop="emit('move', 1)">↓</button>
      </span>

      <button class="pe-chip-btn pe-chip-btn-del" title="删除" @click.stop="emit('remove')">×</button>
    </span>

    <ItemTranslationCell
      :item="item"
      :busy="busy"
      :failed="failed"
      @commit-translation="emit('commit-translation')"
      @promote="emit('promote')"
      @translate="emit('translate')"
    />
  </div>
</template>

<style scoped>
.pe-chip-cell {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  max-width: 100%;
}

.pe-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  min-height: 24px;
  background: var(--panel-2, #22262e);
  cursor: text;
  user-select: none;
}

.pe-chip:hover {
  border-color: var(--accent, #6ea8fe);
}

.pe-chip-off {
  opacity: 0.45;
  text-decoration: line-through;
}

.pe-chip-dragging {
  outline: 1px dashed var(--accent, #6ea8fe);
}

.pe-chip-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.pe-chip-input {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  min-width: 60px;
  width: 100%;
  padding: 0;
  outline: none;
}

.pe-chip-btn {
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: 4px;
  opacity: 0;
}

.pe-chip:hover .pe-chip-btn {
  opacity: 1;
}

.pe-chip-btn:hover {
  background: var(--line, #2e333d);
  color: var(--fg, #e6e8ec);
}

.pe-chip-btn-del:hover {
  color: var(--danger, #ff7b72);
}

/* 触屏专属的那一排（禁用 / 上移 / 下移）：默认不显示，见下面的 hover: none */
.pe-chip-tools {
  display: none;
  flex: none;
  gap: 2px;
}

.pe-chip-tool {
  border: 1px solid var(--line, #2e333d);
  border-radius: 4px;
  background: var(--panel, #1b1e24);
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 5px 6px;
  cursor: pointer;
}

@media (hover: none) {
  .pe-chip-tools {
    display: inline-flex;
  }

  /* 「×」原来是悬停才出现的（opacity: 0）—— 触摸屏上永远不会悬停，等于没有删除入口。
     顺手把这一排和「×」撑到指头点得准：它们原来只有 19×21 */
  .pe-chip-btn,
  .pe-chip-tool {
    opacity: 1;
    min-width: 28px;
    min-height: 28px;
    padding: 5px 6px;
  }
}

@media (max-width: 720px) {
  .pe-chip {
    min-height: 30px;
    padding: 4px 4px 4px 8px;
  }
}
</style>
