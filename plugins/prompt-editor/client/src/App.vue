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
import { computed, onMounted, ref, watch } from 'vue';

import AiChatCard from './components/AiChatCard.vue';
import BlockCard from './components/BlockCard.vue';
import BlockLibraryPanel from './components/BlockLibraryPanel.vue';
import CrossCallPanel from './components/CrossCallPanel.vue';
import EditorChrome from './components/EditorChrome.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import OutputPane from './components/OutputPane.vue';
import PresetPanel from './components/PresetPanel.vue';
import TagLibraryPanel from './components/TagLibraryPanel.vue';
import TranslatePanel from './components/TranslatePanel.vue';
import { fetchDraft, fetchSettings, type BlockPreset, type LlmSuggestion, type Settings } from './api';
import type { LlmTurn } from './api-llm-chat';
import { canDropItem, moveItem, newItem, splitByMode, type Block, type Doc, type ItemRef } from './model';
import { useNotice } from './composables/useNotice';
import { useTouchItemDrag } from './composables/useTouchItemDrag';
import { useTranslate } from './composables/useTranslate';
import { useWorkspace } from './composables/useWorkspace';
import type { PendingBlock } from './composables/useBlockLibrary';

const { notice, flash } = useNotice();
const {
  doc,
  activeBlockId,
  output,
  itemCount,
  blockCount,
  unusedCount,
  draftLabel,
  blockLabels,
  replaceDoc,
  expandAll,
  addBlock,
  removeBlock,
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
/** 设置面板（左侧栏分节，现在只有 AI 一节）：顶栏「设置…」与卡片头部「LLM 设置」都开它 */
const settingsOpen = ref(false);
/** 设置保存后 +1：AI 卡片重拉模板（总闸可能刚打开） */
const llmVersion = ref(0);
const libOpen = ref(false);
const blockLibOpen = ref(false);
/** 从区块表头「存」送过来的那一块快照：区块库面板据此弹出"起个名字" */
const blockPending = ref<PendingBlock | null>(null);

/**
 * 关掉区块库面板 = 这次"存块"**不作数**。
 *
 * 只把 `blockLibOpen` 置 false 的话，`blockPending` 会留着 —— 下次从「区块库…」进来
 * 又弹回待存那一屏（已经叉掉的那块阴魂不散）。
 */
function closeBlockLibrary(): void {
  blockLibOpen.value = false;
  blockPending.value = null;
}

/** 手机：工作区 / AI / 输出 三屏切换 —— 窄屏叠起来时，输出区会被压在几十张卡片底下 */
const view = ref<'workspace' | 'output' | 'ai'>('workspace');

const dragBlock = ref<number | null>(null);
const overBlock = ref<number | null>(null);
/**
 * 条目拖拽的状态放在这一层，因为它是**跨块**的：块内那份局部状态挪到父级才能算出
 * "这块接不接得住"（只有块类型相同才接，见 model.canDropItem）。
 */
const dragItem = ref<ItemRef | null>(null);
const overItem = ref<ItemRef | null>(null);
const settings = ref<Settings>({
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  minIntervalMs: 6000,
  llm: {
    enabled: false,
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKeySet: false,
    timeoutMs: 60000,
    maxCallsPerDay: 200,
    newBlockColor: '#6ea8fe',
    maxToolRounds: 12,
  },
});

const { busyIds, failedIds, enqueueAuto, translateItem, translateBlock, promoteTranslation, onTranslationEdited } =
  useTranslate({ settings, flash, persistItems });

/**
 * 触屏上 HTML5 拖拽压根不触发（`dragstart` 只有鼠标才有），所以**区块**换位退化成 ↑↓。
 * 按钮只在 `hover: none` 的设备上出现（见 BlockHeader），鼠标用户照旧拖。
 */
function moveBlock(index: number, delta: number): void {
  const to = index + delta;
  const moved = doc.blocks[index];
  if (moved === undefined || to < 0 || to >= doc.blocks.length) return;
  doc.blocks.splice(index, 1);
  doc.blocks.splice(to, 0, moved);
  persistStructure();
}

/** 底部操作条上的「新建区块」：在输出屏上点它，得先回到工作区，否则新块加在看不见的地方 */
function addBlockFromChrome(): void {
  view.value = 'workspace';
  addBlock();
}

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

/**
 * 触屏条目拖拽：和桌面 HTML5 drag 共用 `dragItem` / `overItem` / `dropItemAt` 这一套状态，
 * 只是"起手"来自条目上的 ⠿ 把手，后续的悬停/落地由 window 上的 Pointer Events 接管。
 */
const { ghost: touchGhost, begin: beginTouchItemDrag } = useTouchItemDrag({
  onStart: (blockId, index) => startItemDrag(blockId, index),
  onOver: (target) => {
    if (target === null) {
      overItem.value = null;
      return;
    }
    overItemAt(target.blockId, target.index);
  },
  onDrop: (target) => {
    if (target === null) {
      endItemDrag();
      return;
    }
    dropItemAt(target.blockId, target.index);
  },
});

const touchGhostStyle = computed(() => {
  const g = touchGhost.value;
  return { left: g === null ? '0px' : `${g.x}px`, top: g === null ? '0px' : `${g.y}px` };
});

function loadPreset(next: Doc): void {
  replaceDoc(next);
  // 收起是**我当前工作区**的视图状态，不是那份内容的一部分：预设进来一律展开
  expandAll();
  presetOpen.value = false;
  flash('预设已载入工作区');
  persistDoc();
  // 预设里可能本来就有没译文的条目（手写的一份 / 之前自动译关着的时候存的）：跟"条目变了"同一条路
  for (const block of doc.blocks) enqueueAuto(block);
}

/** 设置面板保存后回填：自动译开关要立刻生效，不用刷新页面 */
function applySettings(next: Settings): void {
  settings.value = next;
}

/** 打开设置面板（顶栏「设置…」/ 卡片头部「LLM 设置」都走这里） */
function openSettings(): void {
  settingsOpen.value = true;
}

/** LLM 设置保存成功：面板**不自动关**（让人看见「已保存」），重取设置让总闸立刻生效 */
async function onLlmSettingsSaved(): Promise<void> {
  try {
    settings.value = (await fetchSettings()).settings;
  } catch {
    // 拿不到设置不致命：卡片在 403 时自己会切成"未启用"
  }
  llmVersion.value += 1;
}

/**
 * 总闸关掉 = 卡片整个消失（模板 v-if），手机上的「AI」那一屏也跟着没了 ——
 * 视图还停在 'ai' 的话会看到一片空白，退回工作区。
 */
watch(
  () => settings.value.llm.enabled,
  (enabled) => {
    if (!enabled && view.value === 'ai') view.value = 'workspace';
  },
);

/**
 * 一轮对话收工：AI 已经即时落盘，这里回读草稿并给动过的块补翻。
 *
 * 删除也要认（`turn.deleted`）：草稿被删空时同样得回读，否则工作区里还留着已经删掉的块。
 */
async function onLlmTurn(turn: LlmTurn): Promise<void> {
  if (turn.reply !== '') flash(`AI：${turn.reply.slice(0, 60)}`);
  const touchedAny = turn.changed.length + turn.created.length + turn.deleted.length > 0;
  try {
    const stored = await fetchDraft();
    if (stored !== null && (stored.blocks.length > 0 || touchedAny)) replaceDoc(stored);
    const touched = new Set([...turn.changed, ...turn.created]);
    for (const block of doc.blocks) if (touched.has(block.id)) enqueueAuto(block);
  } catch {
    // 回读失败不致命：卡片已经展示了这一轮的结果
  }
}

/** 建议落地：走人类同款路径（按块模式重切 + PUT 条目），不经过 LLM 写门禁 */
function applySuggestion(suggestion: LlmSuggestion): void {
  const block = doc.blocks.find((one) => one.id === suggestion.blockId);
  if (block === undefined) return;
  block.items = splitByMode(suggestion.content, block.mode).map((text) => newItem(text));
  persistItems(block);
  enqueueAuto(block);
  flash('建议已应用到区块');
}

/** 条目变了：落盘 + （自动译开着的话）排队去翻还没有译文的那几条 */
function onItemsCommitted(block: Block): void {
  persistItems(block);
  enqueueAuto(block);
}

/**
 * 整块「不用 / 启用」：属性本身走 `structure-changed` 那条路落盘，这里只管翻译队列 ——
 * 不使用的块不进队列（别为不进输出的内容花配额），所以**重新启用**时得补排一次。
 */
function onBlockEnabledChanged(block: Block): void {
  if (block.enabled) enqueueAuto(block);
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
    <EditorChrome
      v-model:view="view"
      :draft-label="draftLabel"
      :notice="notice"
      @add-block="addBlockFromChrome"
      @open-preset="presetOpen = true"
      @open-lib="libOpen = true"
      @open-block-library="blockLibOpen = true"
      @open-translate="translateOpen = true"
      :ai-enabled="settings.llm.enabled"
      @open-settings="openSettings"
    />

    <div class="pe-body" :class="'pe-view-' + view">
      <!--
        左列（工作区 + AI 卡片）装在一个 flex 列里。AI 卡片不能当 `.pe-body` 的直接 grid 孩子：
        那样它落在第 2 行第 1 列，而第 1 行的高度由两列里更高的那个决定 —— 右侧输出栏高的时候，
        工作区下面就空一大片（实测 442px）。手机上它是第三个视图，见 app.css 的 720px 那条。
      -->
      <div class="pe-main">
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
            @move="(delta: number) => moveBlock(index, delta)"
            @item-drag-start="(itemIndex: number) => startItemDrag(block.id, itemIndex)"
            @item-drag-over="(itemIndex: number) => overItemAt(block.id, itemIndex)"
            @item-drop="(itemIndex: number) => dropItemAt(block.id, itemIndex)"
            @item-drag-end="endItemDrag()"
            @item-touch-drag-start="
              (itemIndex: number, event: PointerEvent) =>
                beginTouchItemDrag(event, block.id, itemIndex, block.items[itemIndex]?.text ?? '')
            "
            @structure-changed="persistStructure()"
            @items-committed="onItemsCommitted(block)"
            @enabled-changed="onBlockEnabledChanged(block)"
            @translate="(itemIndex: number) => translateItem(block, itemIndex)"
            @translate-block="translateBlock(block)"
            @translation-edited="(text: string, translation: string) => onTranslationEdited(text, translation)"
            @promote="(itemIndex: number) => promoteTranslation(block, itemIndex)"
          />
          <button class="pe-add-block" @click="addBlock">+ 新建区块</button>
        </section>

        <AiChatCard
          v-if="settings.llm.enabled"
          :blocks="doc.blocks"
          :version="llmVersion"
          :enabled="settings.llm.enabled"
          @open-settings="openSettings"
          @changed="onLlmTurn"
          @apply-suggestion="applySuggestion"
        />
      </div>

      <aside class="pe-side">
        <OutputPane :text="output" :item-count="itemCount" :block-count="blockCount" :unused-count="unusedCount" />
        <CrossCallPanel :text="output" />
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
      @close="closeBlockLibrary"
      @cancel-pending="blockPending = null"
      @insert="insertPresetBlock"
    />
    <TranslatePanel :open="translateOpen" @close="translateOpen = false" @saved="applySettings" />
    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" @saved="onLlmSettingsSaved" />

    <!-- 触屏拖拽的幽灵：跟着手指走，说明"现在拖的是哪一条"（pointer-events: none，见 app.css） -->
    <div v-if="touchGhost" class="pe-touch-ghost" :style="touchGhostStyle">{{ touchGhost.text }}</div>
  </div>
</template>

<style scoped src="./app.css"></style>
