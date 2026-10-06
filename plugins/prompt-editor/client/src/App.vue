<script setup lang="ts">
/**
 * 提示词编辑器：左「工作区」（区块 + 条目），右「输出区」（拼接后的纯文本）。
 *
 * 唯一真源是 `doc`（区块/条目），输出与草稿都是它的派生：
 * - 输出 = renderOutput(doc)，结构不进文本；
 * - 草稿 = 编辑时按"改了多大一块"发增量（结构 / 某个组的条目），预设库另存结构。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

import BlockCard from './components/BlockCard.vue';
import OutputPane from './components/OutputPane.vue';
import PresetPanel from './components/PresetPanel.vue';
import TagLibraryPanel from './components/TagLibraryPanel.vue';
import TranslatePanel from './components/TranslatePanel.vue';
import {
  fetchDraft,
  fetchSettings,
  saveDraft,
  saveDraftItems,
  saveDraftStructure,
  saveTagEntry,
  translateTexts,
  type TagEntry,
  type TranslateSettings,
} from './api';
import {
  cloneDoc,
  countItems,
  newBlock,
  newItem,
  renderOutput,
  starterDoc,
  type Block,
  type Doc,
  type Item,
} from './model';

const doc = reactive<Doc>(starterDoc());
const presetOpen = ref(false);
const translateOpen = ref(false);
const libOpen = ref(false);
/** 工作区里最后碰过的块：词库面板「插入到」的默认目标 */
const activeBlockId = ref('');
const notice = ref('');
const draftState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const dragBlock = ref<number | null>(null);
const overBlock = ref<number | null>(null);
const settings = ref<TranslateSettings>({
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  minIntervalMs: 6000,
});

// 正在翻 / 没翻成的条目 id。reactive(Set) 才能让 `.add/.delete` 触发重渲染。
const busyIds = reactive(new Set<string>());
const failedIds = reactive(new Set<string>());

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

/** 词库面板「插入到」的下拉：第 N 块 · 标题 */
const blockLabels = computed(() => doc.blocks.map((block, index) => ({
  id: block.id,
  label: `第 ${index + 1} 块${block.title === '' ? '' : ` · ${block.title}`}`,
})));

function replaceDoc(next: Doc): void {
  doc.version = 1;
  doc.blocks = next.blocks;
}

function addBlock(): void {
  doc.blocks.push(newBlock(`区块 ${doc.blocks.length + 1}`));
  persistStructure();
}

function removeBlock(index: number): void {
  doc.blocks.splice(index, 1);
  persistStructure();
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
  persistStructure();
}

function clearAll(): void {
  if (!window.confirm('清空当前工作区？（预设库里已保存的不受影响）')) return;
  replaceDoc({ version: 1, blocks: [newBlock('区块 1')] });
  persistDoc();
}

function loadPreset(next: Doc): void {
  replaceDoc(next);
  presetOpen.value = false;
  flash('预设已载入工作区');
  persistDoc();
}

// ── 草稿：编辑热路径上只有两个写事件 ─────────────────────────────────────────
//
// 1. 组结构变了（区块增删/排序/标题/颜色/风格）→ 只发结构，不含条目
// 2. 某个组编辑完了（那个组的条目变了）        → 只发那个组的条目
//
// 不再"深监听整个 doc + 防抖整份发"：那样改一个字就要把全文档序列化传一遍，
// 而且防抖窗口里切 tab / 关页面会把最后一次改动丢掉（现在失焦即写，没有待发队列）。
// 载入预设 / 清空是整份替换，不在热路径上，单独走 persistDoc()。

function mark(state: 'saved' | 'error'): void {
  draftState.value = state;
}

function persistStructure(): void {
  draftState.value = 'saving';
  const blocks = doc.blocks.map(({ id, title, color, mode }) => ({ id, title, color, mode }));
  void saveDraftStructure(blocks)
    .then(() => mark('saved'))
    .catch(() => mark('error'));
}

function persistItems(block: { id: string; items: Item[] }): void {
  draftState.value = 'saving';
  void saveDraftItems(block.id, block.items)
    .then(() => mark('saved'))
    .catch(() => mark('error'));
}

function persistDoc(): void {
  draftState.value = 'saving';
  void saveDraft(cloneDoc(doc))
    .then(() => mark('saved'))
    .catch(() => mark('error'));
}

// ── 翻译：词库优先 + provider 兜底（固定 en→zh）──────────────────────────────
//
// 一条译文有三种来路：**词库命中**（瞬时、零请求、零配额）、**现翻**（有道体验版）、
// **用户手填**（写回词库，之后自动命中，且永不被 API 覆盖）。
//
// 自动译只发生在"条目编辑完"之后，并且攒 400ms 合并成一批 —— 连着敲几条 tag 只发一次请求。
// 队列只收**还没有译文**的条目：已有译文（手改的、之前翻好的）一律不动。
// 没翻成的只在那个格子上留个记号（红框），不弹窗、不挡写作。

interface TranslateJob {
  item: Item;
  block: Block;
}

const queue = new Map<string, TranslateJob>();
let queueTimer: number | null = null;

function enqueueAuto(block: Block): void {
  if (!settings.value.autoTranslate) return;
  for (const item of block.items) {
    if (item.translation !== '' || item.text.trim() === '') continue;
    queue.set(item.id, { item, block });
  }
  if (queue.size === 0) return;
  if (queueTimer !== null) clearTimeout(queueTimer);
  queueTimer = window.setTimeout(() => {
    queueTimer = null;
    const jobs = [...queue.values()];
    queue.clear();
    void runTranslate(jobs, false);
  }, 400);
}

/**
 * 逐条翻译：**一次只发一条，上一条回来才发下一条**。
 *
 * 不打包成一批，是因为 provider 那边本来就是一个 q 一次调用（体验版一次只收一条），
 * 打包只会让一次 HTTP 请求挂很久（节流 6s × 10 条 = 1 分钟），而且中途失败会连坐整批。
 * 逐条发：进度看得见（正在翻的那条显示「…」）、失败只影响那一条、每个请求都短。
 * 合并请求的好处已经由 `enqueueAuto` 的 400ms 防抖队列给了。
 */
async function runTranslate(jobs: TranslateJob[], manual: boolean): Promise<void> {
  const live = jobs.filter((job) => job.item.text.trim() !== '');
  if (live.length === 0) {
    if (manual) flash('这里没有可翻的条目');
    return;
  }

  // 译文也算"这个组编辑完了"：不落盘的话刷新一下刚翻的译文就没了（按组去重，一组一次写）
  const touched = new Map<string, Block>();
  let hits = 0;
  let skipped = 0;
  let lastError = '';

  for (const job of live) {
    busyIds.add(job.item.id);
    failedIds.delete(job.item.id);
    try {
      const outcome = await translateTexts([job.item.text]);
      if (outcome.error !== undefined) lastError = outcome.error.message;
      const result = outcome.results[0];
      if (result === undefined) continue;
      if (result.translation !== '') {
        job.item.translation = result.translation;
        // 词库命中：人认可的标 user（「我」），导入/内置的标 dict（「库」）；现翻的标 api（「机」）
        job.item.source = result.source === 'api' ? 'api' : 'dict';
        touched.set(job.block.id, job.block);
        if (result.source !== 'api') hits += 1;
      } else if (result.source === 'skip') {
        skipped += 1;
      } else if (result.source === 'error') {
        failedIds.add(job.item.id);
      }
    } catch (error) {
      failedIds.add(job.item.id);
      lastError = (error as Error).message;
    } finally {
      busyIds.delete(job.item.id);
    }
  }
  for (const block of touched.values()) persistItems(block);

  if (lastError !== '') flash(`翻译：${lastError}`);
  else if (manual && touched.size === 0 && skipped > 0) flash('这一条是权重语法或模型名，不需要翻');
  else if (manual) flash(hits > 0 ? `翻译完成（${hits} 条直接命中词库）` : '翻译完成');
}

function translateItem(block: Block, index: number): void {
  const item = block.items[index];
  if (item === undefined) return;
  void runTranslate([{ item, block }], true);
}

/** 整块「译」：**已经有译文的不动**（要重翻某一条就点它自己的「译」） */
function translateBlock(block: Block): void {
  const jobs = block.items
    .filter((item) => item.enabled && item.text.trim() !== '' && item.translation === '')
    .map((item) => ({ item, block }));
  if (jobs.length === 0) {
    flash('这一块都有译文了（要重翻某一条，点它自己的「译」）');
    return;
  }
  void runTranslate(jobs, true);
}

/** 把机器翻的存进词库：存过之后自动译直接命中它，也不会再被覆盖 */
function promoteTranslation(block: Block, index: number): void {
  const item = block.items[index];
  if (item === undefined || item.translation.trim() === '') return;
  void saveTagEntry({ en: item.text, zh: item.translation, source: 'user' })
    .then(() => {
      // 进库了就不再是"现翻的"（徽章只说在不在库里）—— 存成功才翻牌，失败就还是「机」
      item.source = 'dict';
      persistItems(block);
      flash(`「${item.text}」已存进词库`);
    })
    .catch((error: Error) => flash(`存词库失败：${error.message}`));
}

/** 词库面板里点「插入」：把这条词连译文一起加进目标块 */
function insertTagEntry(entry: TagEntry): void {
  const block = doc.blocks.find((one) => one.id === activeBlockId.value) ?? doc.blocks[0];
  if (block === undefined) return;
  const same = (a: string): string => a.trim().toLowerCase();
  if (block.items.some((item) => same(item.text) === same(entry.en))) {
    flash(`「${entry.en}」这块里已经有了`);
    return;
  }
  const item = newItem(entry.en);
  // 译文一起带上：库里已经有中文了，这条不需要再问接口（词库的价值就在这）
  item.translation = entry.zh;
  item.source = 'dict';
  block.items.push(item);
  activeBlockId.value = block.id;
  persistItems(block);
  flash(`已插入「${entry.en}」，译文一起带上了`);
}

/** 设置面板保存后回填：自动译开关要立刻生效，不用刷新页面 */
function applySettings(next: TranslateSettings): void {
  settings.value = next;
}

/** 手改的译文写回词库：以后自动译命中它，API 结果也不再覆盖 */
function onTranslationEdited(block: Block, text: string, translation: string): void {
  void saveTagEntry({ en: text, zh: translation, source: 'user' }).catch(() => {
    // 词库没写上不影响用：条目自己的译文已经跟着草稿落盘了
  });
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

onUnmounted(() => {
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  if (queueTimer !== null) clearTimeout(queueTimer);
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
          @translation-edited="(text: string, translation: string) => onTranslationEdited(block, text, translation)"
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
