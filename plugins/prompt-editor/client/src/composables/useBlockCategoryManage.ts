/**
 * 区块库左栏的**分类管理**：编辑模式开关 + 新建 / 改名 / 删 / 排序的中间状态。
 *
 * 从 `useBlockLibrary.ts` 拆出来（那边一度压过 300 行）：分类是一张独立的表，跟"某一块属于谁"
 * 是两件事，拆开后"一次只摆一件事"的状态机也看得更清楚。
 *
 * `run` / `refresh` 由主组合子传进来（请求外壳与列表刷新只有一份）。
 */
import { ref, type Ref } from 'vue';

import {
  createBlockCategory,
  deleteBlockCategory,
  renameBlockCategory,
  reorderBlockCategories,
  type BlockCategorySummary,
} from '../api';

export function useBlockCategoryManage(shell: {
  categories: Ref<BlockCategorySummary[]>;
  /** 左栏选中项：`null` = 全部，`''` = 未分类 */
  activeCat: Ref<string | null>;
  run: (action: () => Promise<void>, done: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  /** 编辑模式：**插入和编辑互斥** —— 开着时行上只有改名 / 删除，左栏才有管理入口 */
  const editMode = ref(false);
  const creatingCategory = ref(false);
  const newCategory = ref('');
  const renamingCategory = ref('');
  const renameTo = ref('');
  const confirmRemove = ref<{ id: string; name: string; count: number } | null>(null);

  function cancelCreateCategory(): void {
    creatingCategory.value = false;
    newCategory.value = '';
  }

  function cancelRenameCategory(): void {
    renamingCategory.value = '';
    renameTo.value = '';
  }

  function cancelRemoveCategory(): void {
    confirmRemove.value = null;
  }

  function startCreateCategory(): void {
    cancelRenameCategory();
    cancelRemoveCategory();
    creatingCategory.value = true;
  }

  function startRenameCategory(category: BlockCategorySummary): void {
    cancelCreateCategory();
    cancelRemoveCategory();
    renamingCategory.value = category.id;
    renameTo.value = category.name;
  }

  function askRemoveCategory(category: BlockCategorySummary): void {
    cancelCreateCategory();
    cancelRenameCategory();
    confirmRemove.value = { id: category.id, name: category.name, count: category.count };
  }

  async function submitCreateCategory(): Promise<void> {
    const label = newCategory.value.trim();
    if (label === '') return;
    cancelCreateCategory();
    await shell.run(async () => {
      await createBlockCategory(label);
      await shell.refresh();
    }, `已新建分类「${label}」`);
  }

  async function submitRenameCategory(): Promise<void> {
    const id = renamingCategory.value;
    const label = renameTo.value.trim();
    if (id === '' || label === '') return;
    cancelRenameCategory();
    await shell.run(async () => {
      await renameBlockCategory(id, label);
      await shell.refresh();
    }, '已改名');
  }

  async function submitRemoveCategory(): Promise<void> {
    const target = confirmRemove.value;
    if (target === null) return;
    cancelRemoveCategory();
    await shell.run(async () => {
      await deleteBlockCategory(target.id);
      if (shell.activeCat.value === target.id) shell.activeCat.value = null;
      await shell.refresh();
    }, `已删除分类「${target.name}」（里面的块回到未分类）`);
  }

  /** 退出编辑模式：把关着的那几件半成品一起收掉（关开关、重开面板都走它） */
  function exitEditMode(): void {
    editMode.value = false;
    cancelCreateCategory();
    cancelRenameCategory();
    cancelRemoveCategory();
  }

  function toggleEditMode(): void {
    if (editMode.value) exitEditMode();
    else editMode.value = true;
  }

  async function reorderCategories(ids: string[]): Promise<void> {
    await shell.run(async () => {
      await reorderBlockCategories(ids);
      await shell.refresh();
    }, '已调整分类顺序');
  }

  return {
    editMode,
    creatingCategory,
    newCategory,
    renamingCategory,
    renameTo,
    confirmRemove,
    startCreateCategory,
    cancelCreateCategory,
    submitCreateCategory,
    startRenameCategory,
    cancelRenameCategory,
    submitRenameCategory,
    askRemoveCategory,
    cancelRemoveCategory,
    submitRemoveCategory,
    exitEditMode,
    toggleEditMode,
    reorderCategories,
  };
}
