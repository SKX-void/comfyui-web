<script setup lang="ts">
/**
 * 一个区块卡片：工作区里的"顶层结构"。只做视觉分组（边框 + 标题 + 颜色），不嵌套。
 *
 * 这里**直接改 props 里的嵌套字段**（block.title / block.items）而不是 emit 一份新 block：
 * 父级的 doc 本来就是 reactive，条目级操作（重切、排序、增删）必须知道索引，
 * 每次都往上抬一层再传回来只会把代码变长。改的始终是父级那个对象，不是重新赋值 prop。
 */
import { ref } from 'vue';

import ItemChip from './ItemChip.vue';
import { BLOCK_COLORS, newId, splitByMode, type Block, type Item, type Mode } from '../model';

const props = defineProps<{ block: Block; mode: Mode; dragging: boolean; over: boolean }>();
const emit = defineEmits<{
  (e: 'remove'): void;
  (e: 'drag-start'): void;
  (e: 'drag-over'): void;
  (e: 'drop'): void;
  (e: 'drag-end'): void;
  (e: 'translate'): void;
}>();

const paletteOpen = ref(false);
const adding = ref('');
const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);

function pickColor(color: string): void {
  props.block.color = color;
  paletteOpen.value = false;
}

function commitItem(index: number, text: string): void {
  const head = props.block.items[index];
  if (head === undefined) return;
  const parts = splitByMode(text, props.mode);
  if (parts.length === 0) {
    props.block.items.splice(index, 1);
    return;
  }
  // 第一段继承原条目的 id / 禁用态 / 译文；后面的是新块
  const next: Item[] = parts.map((part, i) =>
    i === 0
      ? { ...head, text: part }
      : { id: newId(), text: part, enabled: true, translation: '' },
  );
  props.block.items.splice(index, 1, ...next);
}

function addItems(): void {
  const parts = splitByMode(adding.value, props.mode);
  for (const part of parts) {
    props.block.items.push({ id: newId(), text: part, enabled: true, translation: '' });
  }
  adding.value = '';
}

function toggleItem(index: number): void {
  const item = props.block.items[index];
  if (item === undefined) return;
  item.enabled = !item.enabled;
}

function removeItem(index: number): void {
  props.block.items.splice(index, 1);
}

function endDrag(): void {
  dragIndex.value = null;
  overIndex.value = null;
}

function dropItem(to: number): void {
  const from = dragIndex.value;
  if (from === null || from === to) {
    endDrag();
    return;
  }
  const moved = props.block.items.splice(from, 1)[0];
  if (moved !== undefined) props.block.items.splice(to, 0, moved);
  endDrag();
}
</script>

<template>
  <section
    class="pe-block"
    :class="{ 'pe-block-over': over }"
    :style="{ borderColor: block.color }"
    @dragover.prevent
    @drop.prevent="emit('drop')"
  >
    <header
      class="pe-block-head"
      draggable="true"
      @dragstart="emit('drag-start')"
      @dragover.prevent="emit('drag-over')"
      @drop.prevent="emit('drop')"
      @dragend="emit('drag-end')"
    >
      <button
        class="pe-block-dot"
        :style="{ background: block.color }"
        title="改颜色"
        @click.stop="paletteOpen = !paletteOpen"
      />
      <input v-model="block.title" class="pe-block-title" placeholder="区块标题" />
      <span class="pe-block-count">{{ block.items.length }} 条</span>
      <button class="pe-block-del" title="删除区块" @click="emit('remove')">×</button>
    </header>

    <div v-if="paletteOpen" class="pe-palette">
      <button
        v-for="color in BLOCK_COLORS"
        :key="color"
        class="pe-swatch"
        :style="{ background: color }"
        :title="color"
        @click="pickColor(color)"
      />
    </div>

    <div class="pe-block-body">
      <ItemChip
        v-for="(item, index) in block.items"
        :key="item.id"
        :item="item"
        :mode="mode"
        :dragging="dragIndex === index"
        :class="{ 'pe-chip-over': overIndex === index && dragIndex !== null && dragIndex !== index }"
        @commit="(text: string) => commitItem(index, text)"
        @toggle="toggleItem(index)"
        @remove="removeItem(index)"
        @translate="emit('translate')"
        @dragstart="dragIndex = index"
        @dragover.prevent="overIndex = index"
        @drop.prevent="dropItem(index)"
        @dragend="endDrag()"
      />
      <input
        v-model="adding"
        class="pe-add"
        :placeholder="mode === 'tag' ? '添加 tag（逗号可一次加多个）' : '添加句子（句号断句）'"
        @keydown.enter.prevent="addItems"
      />
    </div>
  </section>
</template>

<style scoped>
.pe-block {
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
  overflow: hidden;
}

.pe-block-over {
  outline: 2px solid var(--accent, #6ea8fe);
  outline-offset: -2px;
}

.pe-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--panel-2, #22262e);
  border-bottom: 1px solid var(--line, #2e333d);
  cursor: grab;
}

.pe-block-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  flex: none;
  padding: 0;
}

.pe-block-title {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  outline: none;
}

.pe-block-count {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
  white-space: nowrap;
}

.pe-block-del {
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.pe-block-del:hover {
  color: var(--danger, #ff7b72);
}

.pe-palette {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line, #2e333d);
}

.pe-swatch {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  padding: 0;
}

.pe-block-body {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  padding: 10px;
  min-height: 46px;
}

.pe-add {
  flex: 1 1 180px;
  min-width: 140px;
  border: 1px dashed var(--line, #2e333d);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 4px 8px;
  outline: none;
}

.pe-add:focus {
  border-color: var(--accent, #6ea8fe);
}

.pe-chip-over {
  outline: 1px dashed var(--accent, #6ea8fe);
  outline-offset: 2px;
}
</style>
