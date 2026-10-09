/**
 * 区块库列表的**拖拽**：把行拖到左栏分类上 = 归类，拖到另一行上 = 排库内顺序。
 *
 * 从 `useBlockLibrary.ts` 拆出来（那边一度压过 300 行）。拖拽状态必须住在"两个列表的外面"：
 * 被拖的行在右栏，落点在左栏，跨组件；也不能塞 `dataTransfer` —— 拖拽数据只有 `dragstart`
 * 的处理器能写，其它时刻读不到。
 */
import { computed, ref, type Ref } from 'vue';

import { reorderBlockPresets, type BlockPresetSummary } from '../api';

export function useBlockDrag(shell: {
  presets: Ref<BlockPresetSummary[]>;
  /** 左栏选中项：`null` = 全部，`''` = 未分类 */
  activeCat: Ref<string | null>;
  editMode: Ref<boolean>;
  run: (action: () => Promise<void>, done: string) => Promise<void>;
  /** 归类（`PUT /block-presets/:id { categoryId }`）；`''` = 摘掉分类 */
  move: (preset: BlockPresetSummary, categoryId: string) => Promise<void>;
}) {
  const dragKey = ref('');
  /** 行悬停在哪一行分类上：`''` = 未分类，`null` = 没在任何分类上 */
  const dropTarget = ref<string | null>(null);
  /** 行悬停在哪一行块上：插到第 index 行**之前**（`-1` = 没有） */
  const dropIndex = ref(-1);

  /**
   * 行能不能互相拖排序：只认「全部」这一个视图。
   *
   * 筛过的子集里拖出来的新顺序是**相对子集**说的，服务端拿到的 `ids` 只是整库的一部分 ——
   * 拼回去必然错位（词库那边同一个坑，`sortable` 只认"没筛没搜"）。
   */
  const sortable = computed(() => shell.editMode.value && shell.activeCat.value === null);

  function onRowDragStart(preset: BlockPresetSummary): void {
    dragKey.value = preset.id;
  }

  function onDragEnd(): void {
    dragKey.value = '';
    dropTarget.value = null;
    dropIndex.value = -1;
  }

  /** 拖出这一行（拖着路过的每一行都会触发）：落点收起来，下一个 `dragover` 立刻重算 */
  function onDragLeave(): void {
    dropTarget.value = null;
  }

  /** 行拖到左栏的「未分类」/某个分类上 —— 只记落点，改动在 drop 里做 */
  function onDragOverCategory(id: string): void {
    if (dragKey.value === '') return;
    dropTarget.value = id;
  }

  async function onDropOnCategory(id: string): Promise<void> {
    const dragged = shell.presets.value.find((one) => one.id === dragKey.value) ?? null;
    onDragEnd();
    if (dragged !== null) await shell.move(dragged, id);
  }

  /** 行悬停到另一行上：只算落点（dragover 会连续触发，写盘要等 drop） */
  function onRowDragOver(index: number, event: DragEvent): void {
    if (dragKey.value === '' || !sortable.value) return;
    dropTarget.value = null;
    const box = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.() ?? null;
    const after = box !== null && box.height > 0 && event.clientY > box.top + box.height / 2;
    dropIndex.value = after ? index + 1 : index;
  }

  /** 松手：算出新顺序（摘掉自己再插进去），位置没变就不写盘 */
  async function onRowDrop(): Promise<void> {
    const dragged = dragKey.value;
    const to = dropIndex.value;
    onDragEnd();
    if (dragged === '' || to < 0 || !sortable.value) return;
    const ids = shell.presets.value.map((one) => one.id);
    const from = ids.indexOf(dragged);
    if (from < 0) return;
    ids.splice(from, 1);
    // 摘掉自己之后，落在它后面的落点要往前挪一格
    ids.splice(Math.max(0, Math.min(ids.length, to > from ? to - 1 : to)), 0, dragged);
    if (ids.every((id, index) => id === shell.presets.value[index]?.id)) return;
    await shell.run(async () => {
      shell.presets.value = await reorderBlockPresets(ids);
    }, '已调整区块顺序');
  }

  return {
    dragKey,
    dropTarget,
    dropIndex,
    sortable,
    onRowDragStart,
    onDragEnd,
    onDragLeave,
    onDragOverCategory,
    onDropOnCategory,
    onRowDragOver,
    onRowDrop,
  };
}
