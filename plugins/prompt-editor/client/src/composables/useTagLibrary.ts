import { ref, watch } from 'vue';

import { deleteTagEntry, listTags, saveTagEntry, type TagEntry, type TagList } from '../api';

/**
 * 词库面板的状态与请求：面板（TagLibraryPanel）只是它的视图，单行 / 分类树各自成组件。
 *
 * `props` 直接传面板的 props：打开时默认插到"最后碰过的那块"这条规则要跟着
 * `activeBlockId` 走，而这个 id 是工作区（父级）持有的。
 */
export function useTagLibrary(props: {
  open: boolean;
  blocks: { id: string; label: string }[];
  activeBlockId: string;
}) {
  const EMPTY: TagList = { tags: [], total: 0, counts: { total: 0, uncategorized: 0 }, categories: [] };

  const data = ref<TagList>(EMPTY);
  const query = ref('');
  const category = ref('');
  const targetId = ref('');
  const loading = ref(false);
  const error = ref('');
  const hint = ref('');
  /** 正在改 / 正在写的那条（key），用来禁用按钮防连点 */
  const editing = ref('');
  const busy = ref('');
  const form = ref({ zh: '', categories: '', aliases: '' });

  let searchTimer: number | null = null;

  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      data.value = await listTags({ q: query.value, category: category.value, limit: 300 });
    } catch (err) {
      error.value = `读词库失败：${(err as Error).message}`;
    } finally {
      loading.value = false;
    }
  }

  function onSearchInput(): void {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void load(), 250);
  }

  function pickCategory(name: string): void {
    category.value = name;
    void load();
  }

  function splitList(value: string): string[] {
    return value
      .split(/[,，]/)
      .map((one) => one.trim())
      .filter((one) => one !== '');
  }

  function startEdit(entry: TagEntry): void {
    editing.value = entry.key;
    form.value = { zh: entry.zh, categories: entry.categories.join(', '), aliases: entry.aliases.join(', ') };
  }

  function cancelEdit(): void {
    editing.value = '';
  }

  async function saveEdit(entry: TagEntry): Promise<void> {
    busy.value = entry.key;
    error.value = '';
    try {
      // 改了译文 = 我认可了它 → 升成 user（导入的东西以后不许覆盖）；
      // 只改分类/别名就不传 source（server 沿用原值）
      const zh = form.value.zh.trim();
      await saveTagEntry({
        en: entry.en,
        zh,
        categories: splitList(form.value.categories),
        aliases: splitList(form.value.aliases),
        ...(zh !== entry.zh ? { source: 'user' as const } : {}),
      });
      editing.value = '';
      hint.value = '已保存';
      await load();
    } catch (err) {
      error.value = `保存失败：${(err as Error).message}`;
    } finally {
      busy.value = '';
    }
  }

  async function remove(entry: TagEntry): Promise<void> {
    busy.value = entry.key;
    error.value = '';
    try {
      const deleted = await deleteTagEntry(entry.en);
      hint.value = deleted ? `已删掉「${entry.en}」` : '这条已经不在库里了';
      await load();
    } catch (err) {
      error.value = `删除失败：${(err as Error).message}`;
    } finally {
      busy.value = '';
    }
  }

  watch(
    () => props.open,
    (open) => {
      if (!open) return;
      // 打开时默认插到"最后碰过的那块"；没碰过就第一块
      targetId.value = props.activeBlockId !== '' ? props.activeBlockId : (props.blocks[0]?.id ?? '');
      hint.value = '';
      void load();
    },
  );

  // 面板开着的时候工作区改不了（模态遮住了），但重挂/换草稿会换 id，跟着纠正一下
  watch(
    () => props.activeBlockId,
    (id) => {
      if (props.open && id !== '') targetId.value = id;
    },
  );

  return {
    data,
    query,
    category,
    targetId,
    loading,
    error,
    hint,
    editing,
    busy,
    form,
    onSearchInput,
    pickCategory,
    startEdit,
    cancelEdit,
    saveEdit,
    remove,
  };
}
