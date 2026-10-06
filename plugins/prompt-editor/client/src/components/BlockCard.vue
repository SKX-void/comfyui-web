<script setup lang="ts">
/**
 * 一个区块卡片：工作区里的"顶层结构"。只做视觉分组（边框 + 标题 + 颜色），不嵌套。
 *
 * 这里**直接改 props 里的嵌套字段**（block.title / block.items）而不是 emit 一份新 block：
 * 父级的 doc 本来就是 reactive，条目级操作（重切、排序、增删）必须知道索引，
 * 每次都往上抬一层再传回来只会把代码变长。改的始终是父级那个对象，不是重新赋值 prop。
 * 头部（拖动 / 颜色 / 标题 / 风格开关）在 BlockHeader —— 它改的也是同一个 block。
 */
import { ref } from 'vue';

import BlockHeader from './BlockHeader.vue';
import ItemChip from './ItemChip.vue';
import { BLOCK_COLORS, newItem, splitByMode, type Block, type Item } from '../model';

const props = defineProps<{
  block: Block;
  dragging: boolean;
  over: boolean;
  /** 正在翻 / 没翻成的条目 id：只是这一刻的界面状态，不进数据（父级持有） */
  busyIds: Set<string>;
  failedIds: Set<string>;
}>();
const emit = defineEmits<{
  (e: 'remove'): void;
  (e: 'drag-start'): void;
  (e: 'drag-over'): void;
  (e: 'drop'): void;
  (e: 'drag-end'): void;
  /** 翻这一条（用户点了「译」） */
  (e: 'translate', index: number): void;
  /** 翻这一整块 */
  (e: 'translate-block'): void;
  /** 译文格改完了：除了落盘，还要写回词库（改过的就是最终答案） */
  (e: 'translation-edited', text: string, translation: string): void;
  (e: 'promote', index: number): void;
  /** 这块被碰过了 → 上层记成"当前块"（词库面板插入的默认目标） */
  (e: 'activate'): void;
  /** 草稿写事件 1：这个区块的**属性**变了（标题/颜色/风格）——父级只发结构 */
  (e: 'structure-changed'): void;
  /** 草稿写事件 2：这个区块**编辑完了**（条目变了）——父级只发这个区块的条目 */
  (e: 'items-committed'): void;
}>();

const paletteOpen = ref(false);
const adding = ref('');
const addInput = ref<HTMLInputElement | null>(null);
const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);

function pickColor(color: string): void {
  props.block.color = color;
  paletteOpen.value = false;
  emit('structure-changed');
}

/**
 * 译文格改完了：先落盘（条目变了），再写回词库 —— 手改的就是最终答案，
 * 以后自动译命中它、也不会再被 API 结果覆盖。
 */
function onTranslationCommitted(index: number): void {
  const item = props.block.items[index];
  emit('items-committed');
  if (item !== undefined && item.translation.trim() !== '') {
    emit('translation-edited', item.text, item.translation);
  }
}

function commitItem(index: number, text: string): void {
  const head = props.block.items[index];
  if (head === undefined) return;
  const parts = splitByMode(text, props.block.mode);
  if (parts.length === 0) {
    props.block.items.splice(index, 1);
    emit('items-committed');
    return;
  }
  // 第一段继承原条目的 id / 禁用态；后面的是新块。
  // 译文只在**文本没变**时才继承（比如往一条后面追一句，第一段还是它自己）——
  // 文本变了旧译文对应的就是旧文本，留着是错的，而且因为"有译文就不再自动译"，它会一直错下去。
  const next: Item[] = parts.map((part, i) =>
    i > 0
      ? newItem(part)
      : part === head.text
        ? { ...head, text: part }
        : { ...head, text: part, translation: '' },
  );
  props.block.items.splice(index, 1, ...next);
  emit('items-committed');
}

/**
 * 提交「添加」输入框 —— **失焦即提交**（敲回车也提交），不用记着按哪个键。
 *
 * 读的是输入框的实时值，不能只读 `adding`：v-model 在输入法组字期间不更新
 * （Vue 的 vModelText 里 `if (e.target.composing) return`），而中文输入法里"敲回车"往往
 * 就是提交组字的那一下 —— keydown 早于 compositionend，此刻 `adding` 还是空串，
 * 只读它就会把刚敲的字整段吞掉（线上踩过：输入完什么都没进去，输出自然是空的）。
 */
function addItems(): void {
  const input = addInput.value;
  const parts = splitByMode(input?.value ?? adding.value, props.block.mode);
  for (const part of parts) props.block.items.push(newItem(part));
  adding.value = '';
  // v-model 可能因为值没变（组字期间它压根没同步过）而不重渲染，所以显式清掉 DOM
  if (input !== null) input.value = '';
  if (parts.length > 0) emit('items-committed');
}

function toggleItem(index: number): void {
  const item = props.block.items[index];
  if (item === undefined) return;
  item.enabled = !item.enabled;
  emit('items-committed');
}

function removeItem(index: number): void {
  props.block.items.splice(index, 1);
  emit('items-committed');
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
  emit('items-committed');
}
</script>

<template>
  <section
    class="pe-block"
    :class="{ 'pe-block-over': over }"
    :style="{ borderColor: block.color }"
    @click="emit('activate')"
    @dragover.prevent
    @drop.prevent="emit('drop')"
  >
    <BlockHeader
      :block="block"
      :palette-open="paletteOpen"
      @remove="emit('remove')"
      @drag-start="emit('drag-start')"
      @drag-over="emit('drag-over')"
      @drop="emit('drop')"
      @drag-end="emit('drag-end')"
      @translate-block="emit('translate-block')"
      @toggle-palette="paletteOpen = !paletteOpen"
      @structure-changed="emit('structure-changed')"
      @items-committed="emit('items-committed')"
    />

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

    <div class="pe-block-body" :class="{ 'pe-block-body-text': block.mode === 'text' }">
      <ItemChip
        v-for="(item, index) in block.items"
        :key="item.id"
        :item="item"
        :mode="block.mode"
        :dragging="dragIndex === index"
        :busy="busyIds.has(item.id)"
        :failed="failedIds.has(item.id)"
        :class="{ 'pe-chip-over': overIndex === index && dragIndex !== null && dragIndex !== index }"
        @commit="(text: string) => commitItem(index, text)"
        @toggle="toggleItem(index)"
        @remove="removeItem(index)"
        @commit-translation="onTranslationCommitted(index)"
        @promote="emit('promote', index)"
        @translate="emit('translate', index)"
        @dragstart="dragIndex = index"
        @dragover.prevent="overIndex = index"
        @drop.prevent="dropItem(index)"
        @dragend="endDrag()"
      />
      <input
        ref="addInput"
        v-model="adding"
        class="pe-add"
        :placeholder="block.mode === 'tag' ? '添加 tag（逗号可一次加多个）' : '添加句子（句号断句）'"
        @keydown.enter.prevent="addItems"
        @blur="addItems"
        @compositionend="adding = ($event.target as HTMLInputElement).value"
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

/**
 * 自然语言：工作区里也**每句一行**，和输出区一致（tag 块照旧横着排成 tag 流）。
 * 这里只改排版，不动数据 —— 一条一句仍然是各自独立的条目。
 */
.pe-block-body-text {
  flex-direction: column;
  align-items: stretch;
}

/* 竖排时 flex-basis 会变成"高度"，所以输入框在自然语言块里要单独收一下 */
.pe-block-body-text .pe-add {
  flex: 0 0 auto;
  width: 100%;
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
