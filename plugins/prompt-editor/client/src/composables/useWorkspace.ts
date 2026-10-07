import { computed, reactive, ref } from 'vue';

import { saveDraft, saveDraftItems, saveDraftStructure, saveTagEntry, type TagEntry } from '../api';
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
  type Mode,
} from '../model';

/**
 * 工作区：唯一真源是 `doc`（区块/条目），输出与草稿都是它的派生 ——
 * 输出 = renderOutput(doc)，结构不进文本；草稿 = 按"改了多大一块"发增量。
 *
 * `flash` 是注入的：插入词条要提示（「已经有了」/「译文一起带上了」），
 * 而提示本身归 useNotice 管。
 */
export function useWorkspace(flash: (message: string) => void) {
  const doc = reactive<Doc>(starterDoc());
  /** 工作区里最后碰过的块：词库面板「插入到」的默认目标 */
  const activeBlockId = ref('');
  const draftState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const output = computed(() => renderOutput(doc));
  const itemCount = computed(() => countItems(doc));
  const draftLabel = computed(
    () => ({ idle: '', saving: '保存中…', saved: '草稿已保存', error: '草稿保存失败' })[draftState.value],
  );

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

  /**
   * 插入一个**预设区块**：新增一块、**追加到最后**（不动任何已有区块）。
   *
   * 条目文本照抄、**译文不带**（库里的那份可能已经过期，插进来按当前词库重新查才对），
   * 条目 id 现场生成（id 只要在本机文档内唯一）。结构写只带属性，所以条目要单独再写一次
   * —— 跟新建区块同一条路（`persistStructure` + `persistItems`）。
   *
   * **返回插进来的那块**：译文得由上层排队去翻（`enqueueAuto` 在 App 那层，词库/翻译都在那儿）。
   */
  function insertBlockPreset(preset: { name: string; title: string; color: string; mode: Mode; items: string[] }): Block {
    const block = newBlock(preset.title.trim() === '' ? preset.name : preset.title, preset.color, preset.mode);
    block.items = preset.items.map((text) => newItem(text));
    doc.blocks.push(block);
    activeBlockId.value = block.id;
    persistStructure();
    persistItems(block);
    flash(`已插入区块「${preset.name}」（${block.items.length} 条）`);
    return block;
  }

  function removeBlock(index: number): void {
    doc.blocks.splice(index, 1);
    persistStructure();
  }

  function clearAll(): void {
    if (!window.confirm('清空当前工作区？（预设库里已保存的不受影响）')) return;
    replaceDoc({ version: 1, blocks: [newBlock('区块 1')] });
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

  return {
    doc,
    activeBlockId,
    output,
    itemCount,
    draftLabel,
    blockLabels,
    replaceDoc,
    addBlock,
    insertBlockPreset,
    removeBlock,
    clearAll,
    persistStructure,
    persistItems,
    persistDoc,
    insertTagEntry,
  };
}
