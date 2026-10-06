<script setup lang="ts">
/**
 * 提示词编辑器：左「工作区」（区块 + 条目），右「输出区」（拼接后的纯文本）。
 *
 * 唯一真源是 `doc`（区块/条目），输出与草稿都是它的派生：
 * - 输出 = renderOutput(doc)，结构不进文本；
 * - 草稿 = 编辑时按"改了多大一块"发增量（结构 / 某个组的条目），预设库另存结构。
 *
 * 这里只做装配与串线：状态在 composables/，视图在 components/。
 */
import { onMounted, ref } from 'vue';

import BlockCard from './components/BlockCard.vue';
import OutputPane from './components/OutputPane.vue';
import PresetPanel from './components/PresetPanel.vue';
import TagLibraryPanel from './components/TagLibraryPanel.vue';
import TranslatePanel from './components/TranslatePanel.vue';
import { fetchDraft, fetchSettings, type TranslateSettings } from './api';
import type { Block, Doc } from './model';
import { useNotice } from './composables/useNotice';
import { useTranslate } from './composables/useTranslate';
import { useWorkspace } from './composables/useWorkspace';

const { notice, flash } = useNotice();
const {
  doc,
  activeBlockId,
  output,
  itemCount,
  draftLabel,
  blockLabels,
  replaceDoc,
  addBlock,
  removeBlock,
  clearAll,
  persistStructure,
  persistItems,
  persistDoc,
  insertTagEntry,
} = useWorkspace(flash);

const presetOpen = ref(false);
const translateOpen = ref(false);
const libOpen = ref(false);
const dragBlock = ref<number | null>(null);
const overBlock = ref<number | null>(null);
const settings = ref<TranslateSettings>({
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  minIntervalMs: 6000,
});

const { busyIds, failedIds, enqueueAuto, translateItem, translateBlock, promoteTranslation, onTranslationEdited } =
  useTranslate({ settings, flash, persistItems });

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
  persistStructure();
}

function loadPreset(next: Doc): void {
  replaceDoc(next);
  presetOpen.value = false;
  flash('预设已载入工作区');
  persistDoc();
}

/** 设置面板保存后回填：自动译开关要立刻生效，不用刷新页面 */
function applySettings(next: TranslateSettings): void {
  settings.value = next;
}

/** 条目变了：落盘 + （自动译开着的话）排队去翻还没有译文的那几条 */
function onItemsCommitted(block: Block): void {
  persistItems(block);
  enqueueAuto(block);
}

onMounted(async () => {
  try {
    const stored = await fetchDraft();
    if (stored !== null && stored.blocks.length > 0) replaceDoc(stored);
  } catch {
    // 拿不到草稿不是错误：空文档照样能用（后端没起时页面上还有别的提示）
  }
  try {
    settings.value = (await fetchSettings()).settings;
  } catch {
    // 拿不到设置就用默认值（有道体验版、自动译开）：翻译失败会在格子上留记号
  }
});
</script>

<template>
  <div class="pe-app">
    <header class="pe-top">
      <span class="pe-title">工作区</span>
      <span class="pe-draft">{{ draftLabel }}</span>
      <span v-if="notice !== ''" class="pe-notice">{{ notice }}</span>
      <div class="pe-actions">
        <button @click="addBlock">新建区块</button>
        <button @click="presetOpen = true">预设库…</button>
        <button @click="libOpen = true">词库…</button>
        <button @click="translateOpen = true">翻译…</button>
        <button @click="clearAll">清空</button>
      </div>
    </header>

    <div class="pe-body">
      <section class="pe-workspace">
        <BlockCard
          v-for="(block, index) in doc.blocks"
          :key="block.id"
          :block="block"
          :dragging="dragBlock === index"
          :over="overBlock === index && dragBlock !== null && dragBlock !== index"
          :busy-ids="busyIds"
          :failed-ids="failedIds"
          @activate="activeBlockId = block.id"
          @remove="removeBlock(index)"
          @drag-start="dragBlock = index"
          @drag-over="overBlock = index"
          @drop="dropBlock(index)"
          @drag-end="endBlockDrag()"
          @structure-changed="persistStructure()"
          @items-committed="onItemsCommitted(block)"
          @translate="(itemIndex: number) => translateItem(block, itemIndex)"
          @translate-block="translateBlock(block)"
          @translation-edited="(text: string, translation: string) => onTranslationEdited(text, translation)"
          @promote="(itemIndex: number) => promoteTranslation(block, itemIndex)"
        />
        <button class="pe-add-block" @click="addBlock">+ 新建区块</button>
      </section>

      <aside class="pe-side">
        <OutputPane :text="output" :item-count="itemCount" :block-count="doc.blocks.length" />
      </aside>
    </div>

    <PresetPanel :open="presetOpen" :doc="doc" @close="presetOpen = false" @load="loadPreset" />
    <TagLibraryPanel
      :open="libOpen"
      :blocks="blockLabels"
      :active-block-id="activeBlockId"
      @close="libOpen = false"
      @insert="insertTagEntry"
    />
    <TranslatePanel :open="translateOpen" @close="translateOpen = false" @saved="applySettings" />
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

.pe-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted, #9aa3b2);
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
