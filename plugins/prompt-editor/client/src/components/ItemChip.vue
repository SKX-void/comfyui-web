<script setup lang="ts">
/**
 * 一个条目（tag 块 / 句子块）。WeiLin 的 token 块就是这一层：单击改名、双击禁用、单独翻译。
 *
 * 拖动排序不在这里做：组件不声明 drag* 事件，父级的 `@dragstart` 等会**透传到根元素**上，
 * 索引由父级掌握，避免把顺序状态塞进每个块里。
 */
import { nextTick, ref, watch } from 'vue';

import type { Item, Mode } from '../model';

const props = defineProps<{ item: Item; mode: Mode; dragging: boolean }>();
const emit = defineEmits<{
  (e: 'commit', text: string): void;
  (e: 'toggle'): void;
  (e: 'remove'): void;
  (e: 'translate'): void;
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
  editing.value = false;
  const next = draft.value.trim();
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

      <!-- 翻译位：数据源下一步接，先把按钮与译文行留出来 -->
      <button class="pe-chip-btn" title="翻译（下一步接入数据源）" @click.stop="emit('translate')">译</button>
      <button class="pe-chip-btn pe-chip-btn-del" title="删除" @click.stop="emit('remove')">×</button>
    </span>
    <span v-if="item.translation !== ''" class="pe-chip-translation">{{ item.translation }}</span>
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

.pe-chip-translation {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
  padding-left: 8px;
}
</style>
