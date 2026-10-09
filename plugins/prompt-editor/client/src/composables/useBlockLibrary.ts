/**
 * 区块库面板的状态与请求（`BlockLibraryPanel.vue` 只管画）。
 *
 * 这里只管"这一份库"：列表、左栏选中项、存 / 插 / 改名 / 删。两块专门的状态机拆在隔壁 ——
 * 分类管理在 `useBlockCategoryManage.ts`，拖拽在 `useBlockDrag.ts`（这个文件一度压过 300 行）。
 *
 * 分类与顺序都是**库这一侧**的属性（插进工作区时不带走），所以归类 / 排序只在这里发生。
 */
import { computed, ref, watch } from 'vue';

import {
  createBlockPreset,
  deleteBlockPreset,
  exportBlockPresets,
  getBlockPreset,
  importBlockPresets,
  listBlockCategories,
  listBlockPresets,
  updateBlockPreset,
  type BlockCategorySummary,
  type BlockPreset,
  type BlockPresetSummary,
} from '../api';
import type { Mode } from '../model';
import { useBlockCategoryManage } from './useBlockCategoryManage';
import { useBlockDrag } from './useBlockDrag';
import { useImportExport } from './useImportExport';

/** 从区块表头「存」送来的一块快照（要存进库的那个；译文与 id 不在里面） */
export interface PendingBlock {
  title: string;
  color: string;
  mode: Mode;
  items: string[];
}

export function useBlockLibrary(hooks: {
  /** 把一块插进工作区（面板 emit 出去） */
  insert: (preset: BlockPreset) => void;
  /** 待存的块被消费掉了（存成功）—— 面板据此清 `pending` */
  consumePending: () => void;
}) {
  const presets = ref<BlockPresetSummary[]>([]);
  const categories = ref<BlockCategorySummary[]>([]);
  const uncategorized = ref(0);
  /** 左栏选中项：`null` = 全部（默认，找块时最常用），`''` = 未分类 */
  const activeCat = ref<string | null>(null);
  const name = ref('');
  const busyId = ref('');
  const error = ref('');
  const hint = ref('');
  /**
   * 行（预设）上的就地编辑：正在改名的行 id / 名字草稿 / 待确认删除的行 id（一次只有一行）。
   *
   * 不用 `window.prompt` / `window.confirm`（跟词库一致）：浏览器弹窗会打断操作、样式也不跟面板
   * 一致；就地输入才看得见"改的是哪一行"。删要两步：库里这一份删了就没了。
   */
  const presetRenameId = ref('');
  const presetRenameTo = ref('');
  const presetRemoveId = ref('');

  /**
   * 存块时归到哪：**跟着左栏当前选中的分类走**（在「人物」下存块就是人物）。
   *
   * 不给存块那一行配下拉：左栏就在旁边摆着，"我正看着哪一堆"比"从下拉里挑一个"更直接，
   * 也让存块少一个动作（看「全部」或「未分类」时 = 未分类）。想改，存完把行拖走就是了。
   */
  const saveCategoryId = computed(() =>
    typeof activeCat.value === 'string' && activeCat.value !== '' ? activeCat.value : '',
  );

  /** 左栏选什么就筛什么；「全部」不过滤（默认视图是"所有块"，不是"未分类的块"） */
  const visible = computed(() =>
    activeCat.value === null ? presets.value : presets.value.filter((one) => one.categoryId === activeCat.value),
  );

  async function refresh(): Promise<void> {
    try {
      const [list, cats] = await Promise.all([listBlockPresets(), listBlockCategories()]);
      presets.value = list;
      categories.value = cats.categories;
      uncategorized.value = cats.uncategorized;
      // 另一个页面可能刚把分类删了：选中项不能指向不存在的 id（不然左栏"什么都没有"）
      const known = (id: string): boolean => cats.categories.some((one) => one.id === id);
      if (typeof activeCat.value === 'string' && activeCat.value !== '' && !known(activeCat.value)) activeCat.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** 所有动作共用的外壳：统一错误 / 提示（跟 PresetPanel 同一套） */
  async function run(action: () => Promise<void>, done: string): Promise<void> {
    error.value = '';
    hint.value = '';
    try {
      await action();
      hint.value = done;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * 多选 + 导入导出。导入是**写**动作，所以只在编辑模式露出入口（见下面的互斥），
   * 导出与多选是只读的，浏览模式下也能用。
   */
  const transfer = useImportExport({
    error,
    hint,
    label: '区块库',
    exportFile: exportBlockPresets,
    importFile: async (data) => {
      const done = await importBlockPresets(data);
      await refresh();
      const extra: string[] = [];
      if (done.categoriesCreated > 0) extra.push(`新建 ${done.categoriesCreated} 个分类`);
      if (done.categoriesDropped > 0) extra.push(`${done.categoriesDropped} 块因分类满员落到未分类`);
      if (done.skipped > 0) extra.push(`跳过 ${done.skipped} 条认不出的`);
      return `已导入 ${done.imported} 块${extra.length > 0 ? `（${extra.join('，')}）` : ''}`;
    },
  });

  /** 存一块：分类认不出时后端会当未分类，所以这里不校验 `saveCategoryId` */
  async function save(pending: PendingBlock | null): Promise<void> {
    if (pending === null) return;
    const label = name.value.trim();
    if (label === '') {
      error.value = '先给它起个名字';
      return;
    }
    await run(async () => {
      await createBlockPreset({ name: label, categoryId: saveCategoryId.value, ...pending });
      name.value = '';
      hooks.consumePending();
      await refresh();
    }, `已存进区块库：「${label}」（${pending.items.length} 条）`);
  }

  async function insert(preset: BlockPresetSummary): Promise<void> {
    busyId.value = preset.id;
    await run(async () => {
      hooks.insert(await getBlockPreset(preset.id));
    }, `已插入区块「${preset.name}」`);
    busyId.value = '';
  }

  function startRename(preset: BlockPresetSummary): void {
    presetRemoveId.value = '';
    presetRenameId.value = preset.id;
    presetRenameTo.value = preset.name;
  }

  function cancelRename(): void {
    presetRenameId.value = '';
    presetRenameTo.value = '';
  }

  function askRemove(preset: BlockPresetSummary): void {
    cancelRename();
    presetRemoveId.value = preset.id;
  }

  function cancelRemove(): void {
    presetRemoveId.value = '';
  }

  /** 名字没变（或者被清空）就当取消：不发请求，不然「改名」点了没改也算写了一次盘 */
  async function submitRename(): Promise<void> {
    const target = presets.value.find((one) => one.id === presetRenameId.value) ?? null;
    const next = presetRenameTo.value.trim();
    const id = presetRenameId.value;
    if (target === null || next === '' || next === target.name) {
      cancelRename();
      return;
    }
    cancelRename();
    await run(async () => {
      await updateBlockPreset(id, { name: next });
      await refresh();
    }, '已改名');
  }

  async function submitRemove(): Promise<void> {
    const target = presets.value.find((one) => one.id === presetRemoveId.value) ?? null;
    if (target === null) return;
    cancelRemove();
    await run(async () => {
      await deleteBlockPreset(target.id);
      await refresh();
    }, `已删掉库里的「${target.name}」（工作区那块不受影响）`);
  }

  async function move(preset: BlockPresetSummary, categoryId: string): Promise<void> {
    if (categoryId === preset.categoryId) return;
    const target = categories.value.find((one) => one.id === categoryId);
    await run(async () => {
      await updateBlockPreset(preset.id, { categoryId });
      await refresh();
    }, `「${preset.name}」已归到${target === undefined ? '未分类' : `「${target.name}」`}`);
  }

  /**
   * 展开了条目的那一行（块 id）：列表里只有摘要，点开才按 id 取整条，看**全部**条目。
   *
   * 默认全收着 —— 一块能存几百条，全铺出来列表就没法看了。每次展开都重新取（不缓存）：
   * 库里的文件被手改过也不会看到旧的一份。
   */
  const expandedId = ref('');
  const expandedItems = ref<string[]>([]);
  const expandBusy = ref(false);

  async function toggleExpand(preset: BlockPresetSummary): Promise<void> {
    if (expandedId.value === preset.id) {
      expandedId.value = '';
      expandedItems.value = [];
      return;
    }
    expandedId.value = preset.id;
    expandedItems.value = [];
    expandBusy.value = true;
    try {
      const full = await getBlockPreset(preset.id);
      // 取回的路上可能已经收起 / 点了别的行：只认还开着的那一行
      if (expandedId.value === preset.id) expandedItems.value = full.items;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      expandBusy.value = false;
    }
  }

  const manage = useBlockCategoryManage({ categories, activeCat, run, refresh });
  const drag = useBlockDrag({ presets, activeCat, editMode: manage.editMode, run, move });

  // 退出编辑模式就把行上的半成品一起收掉（改名框 / 删确认）——跟左栏管理区一个道理
  watch(manage.editMode, (on) => {
    if (on) {
      // 编辑模式与多选互斥：一个在行上拖和删，一个在行上打勾，混在一起点哪都不是
      transfer.stop();
      return;
    }
    cancelRename();
    cancelRemove();
  });

  // 反过来：进多选就退出编辑模式（`stop` 不会反向触发上面的 watch，它只认"打开"那一下）
  watch(transfer.on, (on) => {
    if (on) manage.exitEditMode();
  });

  return {
    presets,
    categories,
    uncategorized,
    activeCat,
    name,
    busyId,
    error,
    hint,
    presetRenameId,
    presetRenameTo,
    presetRemoveId,
    expandedId,
    expandedItems,
    expandBusy,
    saveCategoryId,
    visible,
    refresh,
    save,
    insert,
    move,
    toggleExpand,
    startRename,
    cancelRename,
    submitRename,
    askRemove,
    cancelRemove,
    submitRemove,
    transfer,
    ...manage,
    ...drag,
  };
}
