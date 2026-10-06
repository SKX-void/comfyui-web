<script setup lang="ts">
/**
 * 提示词编辑器：左「工作区」（区块 + 条目），右「输出区」（拼接后的纯文本）。
 *
 * 唯一真源是 `doc`（区块/条目），输出与草稿都是它的派生：
 * - 输出 = renderOutput(doc)，结构不进文本；
 * - 草稿 = 防抖写进插件自己的空间（刷新不丢工作），预设库另存结构。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

import BlockCard from './components/BlockCard.vue';
import OutputPane from './components/OutputPane.vue';
import PresetPanel from './components/PresetPanel.vue';
import { fetchDraft, saveDraft } from './api';
import { cloneDoc, countItems, newBlock, renderOutput, reflow, starterDoc, type Doc, type Mode } from './model';

const doc = reactive<Doc>(starterDoc());
const presetOpen = ref(false);
const notice = ref('');
const draftState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const dragBlock = ref<number | null>(null);
const overBlock = ref<number | null>(null);

/** 草稿装载完成前不写回：否则会把"刚打开的空文档"覆盖掉盘上的草稿 */
let ready = false;
let draftTimer: number | null = null;
let noticeTimer: number | null = null;

const output = computed(() => renderOutput(doc));
const itemCount = computed(() => countItems(doc));
const draftLabel = computed(
  () => ({ idle: '', saving: '保存中…', saved: '草稿已保存', error: '草稿保存失败' })[draftState.value],
);

function flash(message: string): void {
  notice.value = message;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.value = '';
  }, 3200);
}

function replaceDoc(next: Doc): void {
  doc.version = 1;
  doc.mode = next.mode;
  doc.blocks = next.blocks;
}

function setMode(mode: Mode): void {
  if (mode === doc.mode) return;
  const from = doc.mode;
  // 同一份内容换切分规则：先按旧规则拼回，再按新规则重切
  for (const block of doc.blocks) block.items = reflow(block.items, from, mode);
  doc.mode = mode;
}

function addBlock(): void {
  doc.blocks.push(newBlock(`区块 ${doc.blocks.length + 1}`));
}

function removeBlock(index: number): void {
  doc.blocks.splice(index, 1);
}

function endBlockDrag(): void {
  dragBlock.value = null;
  overBlock.value = null;
}

function dropBlock(to: number): void {
  const from = dragBlock.value;
  if (from === null || from === to) {
    endBlockDrag();
    return;
  }
  const moved = doc.blocks.splice(from, 1)[0];
  if (moved !== undefined) doc.blocks.splice(to, 0, moved);
  endBlockDrag();
}

function clearAll(): void {
  if (!window.confirm('清空当前工作区？（预设库里已保存的不受影响）')) return;
  replaceDoc({ version: 1, mode: doc.mode, blocks: [newBlock('区块 1')] });
}

function loadPreset(next: Doc): void {
  replaceDoc(next);
  presetOpen.value = false;
  flash('预设已载入工作区');
}

onMounted(async () => {
  try {
    const stored = await fetchDraft();
    if (stored !== null && stored.blocks.length > 0) replaceDoc(stored);
  } catch {
    // 拿不到草稿不是错误：空文档照样能用（后端没起时页面上还有别的提示）
  }
  ready = true;
});

watch(
  doc,
  () => {
    if (!ready) return;
    draftState.value = 'saving';
    if (draftTimer !== null) clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      void saveDraft(cloneDoc(doc))
        .then(() => {
          draftState.value = 'saved';
        })
        .catch(() => {
          draftState.value = 'error';
        });
    }, 700);
  },
  { deep: true },
);

onUnmounted(() => {
  if (draftTimer !== null) clearTimeout(draftTimer);
  if (noticeTimer !== null) clearTimeout(noticeTimer);
});
</script>

<template>
  <div class="pe-app">
    <header class="pe-top">
      <div class="pe-modes">
        <button :class="{ active: doc.mode === 'tag' }" @click="setMode('tag')">tag 风格</button>
        <button :class="{ active: doc.mode === 'text' }" @click="setMode('text')">自然语言</button>
      </div>
      <span class="pe-draft">{{ draftLabel }}</span>
      <span v-if="notice !== ''" class="pe-notice">{{ notice }}</span>
      <div class="pe-actions">
        <button @click="addBlock">新建区块</button>
        <button @click="presetOpen = true">预设库…</button>
        <button @click="clearAll">清空</button>
      </div>
    </header>

    <div class="pe-body">
      <section class="pe-workspace">
        <BlockCard
          v-for="(block, index) in doc.blocks"
          :key="block.id"
          :block="block"
          :mode="doc.mode"
          :dragging="dragBlock === index"
          :over="overBlock === index && dragBlock !== null && dragBlock !== index"
          @remove="removeBlock(index)"
          @drag-start="dragBlock = index"
          @drag-over="overBlock = index"
          @drop="dropBlock(index)"
          @drag-end="endBlockDrag()"
          @translate="flash('翻译位已留好：数据源下一步接入，译文会显示在块下方')"
        />
        <button class="pe-add-block" @click="addBlock">+ 新建区块</button>
      </section>

      <aside class="pe-side">
        <OutputPane
          :text="output"
          :mode="doc.mode"
          :item-count="itemCount"
          :block-count="doc.blocks.length"
        />
      </aside>
    </div>

    <PresetPanel :open="presetOpen" :doc="doc" @close="presetOpen = false" @load="loadPreset" />
  </div>
</template>

<style scoped>
.pe-top {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
}

.pe-modes {
  display: inline-flex;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  overflow: hidden;
}

.pe-modes button {
  border: none;
  background: var(--panel-2, #22262e);
  color: var(--muted, #9aa3b2);
  font: inherit;
  padding: 4px 12px;
  cursor: pointer;
}

.pe-modes button.active {
  background: var(--accent, #6ea8fe);
  color: #0b1220;
  font-weight: 600;
}

.pe-draft {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-notice {
  flex: 1;
  font-size: 12px;
  color: var(--accent, #6ea8fe);
}

.pe-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.pe-actions button,
.pe-add-block {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 4px 10px;
  cursor: pointer;
}

.pe-actions button:hover,
.pe-add-block:hover {
  border-color: var(--accent, #6ea8fe);
}

.pe-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
  gap: 12px;
  margin-top: 12px;
  align-items: start;
}

.pe-workspace {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.pe-add-block {
  border-style: dashed;
  color: var(--muted, #9aa3b2);
  padding: 8px;
}

.pe-side {
  position: sticky;
  top: 12px;
  min-width: 0;
}

@media (max-width: 900px) {
  .pe-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .pe-side {
    position: static;
  }
}
</style>
