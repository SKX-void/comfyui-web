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
import BlockLibraryPanel, { type PendingBlock } from './components/BlockLibraryPanel.vue';
import OutputPane from './components/OutputPane.vue';
import PresetPanel from './components/PresetPanel.vue';
import TagLibraryPanel from './components/TagLibraryPanel.vue';
import TranslatePanel from './components/TranslatePanel.vue';
import { fetchDraft, fetchSettings, type BlockPreset, type TranslateSettings } from './api';
import { canDropItem, moveItem, type Block, type Doc, type ItemRef } from './model';
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
  insertBlockPreset,
} = useWorkspace(flash);

/**
 * 区块表头「存」：把这一块的**快照**交给区块库面板，并把它打开问名字。
 *
 * 只收**启用且非空**的条目 —— 禁用的条目本来就不进输出，存进库再插出来等于把它悄悄放回输出。
 * 译文不带（库里那份可能已经过期，插进来按当前词库重新查才对）。
 */
function saveBlockToLibrary(block: Block): void {
  blockPending.value = {
    title: block.title,
    color: block.color,
    mode: block.mode,
    items: block.items.filter((item) => item.enabled && item.text.trim() !== '').map((item) => item.text.trim()),
  };
  blockLibOpen.value = true;
}

const presetOpen = ref(false);
const translateOpen = ref(false);
const libOpen = ref(false);
const blockLibOpen = ref(false);
/** 从区块表头「存」送过来的那一块快照：区块库面板据此弹出"起个名字" */
const blockPending = ref<PendingBlock | null>(null);
const dragBlock = ref<number | null>(null);
const overBlock = ref<number | null>(null);
/**
 * 条目拖拽的状态放在这一层，因为它是**跨块**的：块内那份局部状态挪到父级才能算出
 * "这块接不接得住"（只有块类型相同才接，见 model.canDropItem）。
 */
const dragItem = ref<ItemRef | null>(null);
const overItem = ref<ItemRef | null>(null);
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

/** 区块排序的悬停高亮：拖条目时整块不参与换位，别亮 */
function overBlockAt(index: number): void {
  if (dragItem.value !== null) return;
  overBlock.value = index;
}

function dropBlock(to: number): void {
  const target = doc.blocks[to];
  // 拖的是条目：落点被区块接住（块体空白 / 表头 / 卡片边缘）就当"追加到这块末尾"
  if (dragItem.value !== null) {
    if (target !== undefined) dropItemAt(target.id, target.items.length);
    endItemDrag(); // 落点取不到（理论上不会）也要收手，别把拖拽态留着
    return;
  }
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

// ── 条目拖拽：块内排序 + 跨块搬家（跨块只认类型相同的块）─────────────────────

/** 这块接不接得住正在拖的条目：类型不同就不接（`dropOk` 一路传给 BlockCard 做光标与高亮） */
function canDropInto(block: Block): boolean {
  const from = dragItem.value;
  return from !== null && canDropItem(doc, from, block.id);
}

function startItemDrag(blockId: string, index: number): void {
  dragItem.value = { blockId, index };
  overItem.value = null;
}

function overItemAt(blockId: string, index: number): void {
  const from = dragItem.value;
  if (from === null) return;
  overItem.value = canDropItem(doc, from, blockId) ? { blockId, index } : null;
}

function endItemDrag(): void {
  dragItem.value = null;
  overItem.value = null;
}

/** 落地：真搬了才落盘，**源块和目标块都要发**（草稿是按组存的，不发源块它就还是旧顺序） */
function dropItemAt(blockId: string, index: number): void {
  const from = dragItem.value;
  endItemDrag();
  if (from === null) return;
  const src = doc.blocks.find((block) => block.id === from.blockId);
  const dst = doc.blocks.find((block) => block.id === blockId);
  if (src === undefined || dst === undefined) return;
  if (!moveItem(doc, from, { blockId, index })) return;
  persistItems(src);
  if (dst !== src) persistItems(dst);
}

function loadPreset(next: Doc): void {
  replaceDoc(next);
  presetOpen.value = false;
  flash('预设已载入工作区');
  persistDoc();
  // 预设里可能本来就有没译文的条目（手写的一份 / 之前自动译关着的时候存的）：跟"条目变了"同一条路
  for (const block of doc.blocks) enqueueAuto(block);
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

/**
 * 插入预设区块：**新插进来的那些条目也要排队翻译**。
 *
 * 区块库里刻意不存译文（存的是当时的词库状态，插进来按现在的词库重新查才对），
 * 所以插完这一块必然是"一堆没译文的条目" —— 跟手打一条新条目是同一件事，
 * 得走同一条路（`enqueueAuto`：自动译关着就不发请求，库里命中也不打 provider）。
 */
function insertPresetBlock(preset: BlockPreset): void {
  enqueueAuto(insertBlockPreset(preset));
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
        <button @click="blockLibOpen = true">区块库…</button>
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
          :drag-item="dragItem"
          :over-item="overItem"
          :drop-ok="canDropInto(block)"
          :busy-ids="busyIds"
          :failed-ids="failedIds"
          @activate="activeBlockId = block.id"
          @save-to-library="saveBlockToLibrary(block)"
          @remove="removeBlock(index)"
          @drag-start="dragBlock = index"
          @drag-over="overBlockAt(index)"
          @drop="dropBlock(index)"
          @drag-end="endBlockDrag()"
          @item-drag-start="(itemIndex: number) => startItemDrag(block.id, itemIndex)"
          @item-drag-over="(itemIndex: number) => overItemAt(block.id, itemIndex)"
          @item-drop="(itemIndex: number) => dropItemAt(block.id, itemIndex)"
          @item-drag-end="endItemDrag()"
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
    <BlockLibraryPanel
      :open="blockLibOpen"
      :pending="blockPending"
      @close="blockLibOpen = false"
      @cancel-pending="blockPending = null"
      @insert="insertPresetBlock"
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
