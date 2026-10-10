import { computed, ref, watch } from 'vue';

import {
  deleteCategoryEntries,
  createCategory,
  deleteCategory,
  deleteTagEntry,
  fetchBundledTags,
  importBundledTags,
  listTags,
  renameCategory,
  saveCategoryOrder,
  saveTagEntry,
  saveTagOrder,
  type BundledTags,
  type TagEntry,
  type TagList,
} from '../api';

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
  /** 产物里那两份内置词库表；`null` = 还没问过，`available:false` = 产物里没有 */
  const bundled = ref<BundledTags | null>(null);
  const importing = ref(false);
  /**
   * 正被拖的那一行（key）。**不放 `dataTransfer`**：拖拽数据只在 dragstart 的处理器里能写，
   * 而合成事件（测试造的 DragEvent）压根没有 `dataTransfer` —— 状态放组件里，两边都稳。
   */
  const dragKey = ref('');
  /** 拖到哪个分类上了（`''` = 没在任何落点上；`__none__` = 「未分类」那个落点） */
  const dropTarget = ref('');
  /**
   * 拖拽时的插入位置：`0..tags.length`，`-1` = 没有。
   * 和"拖到分类上"是两件互不打扰的事 —— 一行既能拖到左边换分类，也能拖到两行之间挪位置。
   */
  const dropIndex = ref(-1);

  let searchTimer: number | null = null;

  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      data.value = await listTags({ q: query.value, category: category.value, limit: limit.value });
    } catch (err) {
      error.value = `读词库失败：${(err as Error).message}`;
    } finally {
      loading.value = false;
    }
  }

  /** 问一下产物里有没有内置词库表。失败就当没有（按钮不画），不打扰人 */
  async function loadBundled(): Promise<void> {
    try {
      bundled.value = await fetchBundledTags();
    } catch {
      bundled.value = null;
    }
  }

  /**
   * 导入内置词库。**只有点了才写**：32 万行、十几 MB，不在打开面板时偷偷干。
   * 解析与写库都在服务端（读的是产物自带的 CSV），这里只等结果。
   *
   * 服务端一次导两层（机翻 → 人工），所以提示里要把两层的条数分开说 ——
   * 只说一个总数的话，人会以为"人工那 4 千条是不是没进去"。
   */
  async function importBundled(): Promise<void> {
    importing.value = true;
    error.value = '';
    hint.value = '';
    try {
      const result = await importBundledTags();
      hint.value =
        `入库 ${result.written} 条` +
        (result.layers.length > 1 ? `（${result.layers.map((one) => `${one.name} ${one.written}`).join(' + ')}）` : '') +
        (result.skipped > 0 ? ` · ${result.skipped} 条被守卫挡下，没动` : '') +
        ` · 库内共 ${result.after} 条 · ${(result.elapsedMs / 1000).toFixed(1)}s`;
      await load();
    } catch (err) {
      error.value = `导入失败：${(err as Error).message}`;
    } finally {
      importing.value = false;
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
      // 在面板里动过 = 你认领了它 → 升成 user（导入的东西以后不许覆盖它）。
      // **任何**一处改动都算：导入十几万条之后，你把某条从「机翻-角色」挪进自己的分类、
      // 或给它加个别名，都不该在下一次导入时被打回原形 —— 只认"改过译文"的话，
      // 那批"只挪了分类"的会在重导时被冲回去。
      await saveTagEntry({
        en: entry.en,
        zh: form.value.zh.trim(),
        categories: splitList(form.value.categories),
        aliases: splitList(form.value.aliases),
        source: 'user',
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

  /** 拖拽收尾：清掉落点 / 插入位置 / 拖的那条（写完之后也要清） */
  function dropHidden(): void {
    dropTarget.value = '';
    dropIndex.value = -1;
    dragKey.value = '';
  }

  /**
   * 把某条的分类**置成这一个**（`null` = 清空成未分类）。
   *
   * 只发一个分类是刻意的：一个 tag 只属于一个分类（实测库里 134346 行全是单分类）。
   * 按"加一个"来写的话，某条历史数据带着多分类时拖一下就会变成两个，而拖拽这一路
   * 表达的意思是"换成它"。
   *
   * 与 `saveEdit` 同一条写入路径：**面板里动过就升成 `user`**，所以拖完的分类
   * 以后重导机翻表不会被冲回去。
   */
  async function setCategory(entry: TagEntry, name: string | null): Promise<void> {
    const next = name === null || name === '__none__' ? [] : [name];
    if (next.join() === entry.categories.join()) {
      dropHidden();
      return;
    }
    busy.value = entry.key;
    error.value = '';
    try {
      await saveTagEntry({
        en: entry.en,
        zh: entry.zh,
        categories: next,
        aliases: entry.aliases,
        source: 'user',
      });
      hint.value = next.length === 0 ? `「${entry.en}」已移到未分类` : `「${entry.en}」→ ${next[0]}`;
      await load();
    } catch (err) {
      error.value = `改分类失败：${(err as Error).message}`;
    } finally {
      busy.value = '';
      dropHidden();
    }
  }

  /**
   * 这一页能拖顺序：**只在「全部」且没搜索时**。
   *
   * 顺序是相对"一整页"说的（服务端取左右邻居的中点写 1 行；第一次拖要把这一页铺上序号）。
   * 筛选 / 搜索出来的是一小撮，在那一小撮里拖一下就会把它们整批顶到全库最前面 ——
   * 那不是"我在结果里挪了一下"，是个说不通的副作用。所以筛选态下不接排序（拖到左边换分类照旧）。
   */
  const sortable = computed(() => query.value.trim() === '' && category.value === '');

  /** 一次要多少条：**从 300 起，「加载更多」每次 +300**（服务端夹到 1000） */
  const PAGE = 300;
  const limit = ref(PAGE);
  /**
   * 还有没有更多。`total` 是命中数但**最多报到 `limit + 1`**（精确值要全表再扫一遍，22ms），
   * 所以"比手上这页多"就等于"还有"。
   */
  const hasMore = computed(() => data.value.total > data.value.tags.length);

  /** 服务端上限 1000，到头了就别再给按钮（点了也不会变多） */
  const canLoadMore = computed(() => hasMore.value && limit.value < 1000);

  async function loadMore(): Promise<void> {
    limit.value = Math.min(1000, limit.value + PAGE);
    await load();
  }

  /**
   * 头部那行字。**筛选时要显示命中数**（原来不管搜什么都写全库总数，容易被读成"搜到这么多"）。
   * 命中数被 `limit + 1` 截断时只能写 `N+` —— 精确值要全表扫，是当初故意不做成精确的。
   */
  const headerLabel = computed(() => {
    const all = data.value.counts.total;
    const filtered = query.value.trim() !== '' || category.value !== '';
    if (!filtered) return `共 ${all} 条 · 未分类 ${data.value.counts.uncategorized}`;
    const hits = data.value.total > limit.value ? `${limit.value}+` : String(data.value.total);
    return `命中 ${hits} 条 · 全库 ${all}`;
  });

  function onDragStart(entry: TagEntry): void {
    dragKey.value = entry.key;
  }

  function onDragEnd(): void {
    dragKey.value = '';
    dropTarget.value = '';
    dropIndex.value = -1;
  }

  function onDragOver(name: string): void {
    if (dragKey.value === '') return;
    dropTarget.value = name === '' ? '__all__' : name;
  }

  function onDrop(name: string): void {
    const dragged = data.value.tags.find((one) => one.key === dragKey.value) ?? null;
    if (dragged === null) {
      dropHidden();
      return;
    }
    void setCategory(dragged, name);
  }

  /**
   * 拖到某一行的上/下半边 = 插到它前面/后面。用指针在行内的位置判断，
   * 但**拿不到布局时（测试里 `getBoundingClientRect()` 全是 0）一律当"插到前面"** ——
   * 判断光标提示是锦上添花，不该让拖拽本身炸掉（和 BlockCard 里 `transferOf` 一个道理）。
   */
  function onRowDragOver(index: number, event: DragEvent): void {
    if (dragKey.value === '' || !sortable.value) return;
    dropTarget.value = '';
    const element = event.currentTarget as HTMLElement | null;
    const rect = element?.getBoundingClientRect?.() ?? null;
    const after = rect !== null && rect.height > 0 && event.clientY > rect.top + rect.height / 2;
    dropIndex.value = after ? index + 1 : index;
  }
  /**
   * 松手：把这一行从可见顺序里摘掉、插到落点上，整批写回。
   *
   * 写的是**这一页**的顺序（面板一次 300 条）—— 服务端按 `sort = 1..N` 记下，
   * 有 `sort` 的排在前面，所以拖过的这页会稳定待在顶部，其余仍按热度。
   */
  async function onRowDrop(): Promise<void> {
    const dragged = dragKey.value;
    const to = dropIndex.value;
    dropHidden();
    if (dragged === '' || to < 0 || !sortable.value) return;
    const keys = data.value.tags.map((one) => one.key);
    const from = keys.indexOf(dragged);
    if (from < 0) return;
    // 落点在"自己原来的位置"或紧挨着它，等于没动 —— 不发请求（不然每点一下都写 300 行）
    const moved = [...keys.slice(0, from), ...keys.slice(from + 1)];
    const at = to > from ? to - 1 : to;
    moved.splice(at, 0, dragged);
    if (moved.join() === keys.join()) return;
    busy.value = dragged;
    error.value = '';
    try {
      const result = await saveTagOrder(moved, dragged);
      // 服务端只在"序号还没铺过 / 切尽了"时才重铺整页，如实说出来（不然人会以为每次都这样写）
      hint.value = result.rebuilt ? '顺序已记下（重排了序号）' : '顺序已记下';
      await load();
    } catch (err) {
      error.value = `存顺序失败：${(err as Error).message}`;
    } finally {
      busy.value = '';
    }
  }
  /**
   * 编辑态里点一个分类标签：**切换**它在不在这一条上。
   *
   * 这一路允许攒出多分类（输入框也能）—— 拖拽那条路是"只留一个"，这里不是：
   * 手点的时候"加上去"和"换掉"是两种意图，用输入框的人本来就该看见自己在拼什么。
   * 真正的新分类名只有输入框能造（拖拽的落点只存在于已有名字里）。
   */
  function toggleCategory(name: string): void {
    const list = splitList(form.value.categories);
    const next = list.includes(name) ? list.filter((one) => one !== name) : [...list, name];
    form.value.categories = next.join(', ');
  }
  /** 行上分类标签旁边的「×」：从这一条上摘掉一个分类 */
  async function removeCategory(entry: TagEntry, name: string): Promise<void> {
    await setCategory(entry, entry.categories.filter((one) => one !== name).join(',') || null);
  }  /**
   * 分类树拖完的新顺序（**状态在 TagCategoryNav 里**：拖拽的起点/落点必须是同步的，
   * 绕一趟父组件 props 会慢一拍 —— tag 行那套把状态放在这里是历史原因，分类这版不重复那个坑）。
   */
  async function reorderCategories(names: string[], moved: string): Promise<void> {
    error.value = '';
    try {
      const result = await saveCategoryOrder(names, moved);
      // 第一次拖会整树铺序号（分类只有几个），如实说出来
      hint.value = result.rebuilt ? '分类顺序已记下（重铺了序号）' : '分类顺序已记下';
      await load();
    } catch (err) {
      error.value = `存分类顺序失败：${(err as Error).message}`;
    }
  }

  /**
   * 编辑模式：**插入和编辑互斥** —— 开着时行上只有「改 / 删」（没有「插入」），分类树才有
   * 「＋ 新建分类」和每行的「改 / 清 / 删」。目的是把"会改库的动作"和"往提示词里插词"分开，免得手滑。
   */
  const editMode = ref(false);

  /** 退出编辑模式：把这一层所有"编辑中的半成品"一起收掉（关开关、重开面板都走它） */
  function exitEditMode(): void {
    editMode.value = false;
    cancelEdit();
    cancelCreateCategory();
    cancelRenameCategory();
    cancelRemoveCategory();
    cancelDeleteEntries();
  }

  function toggleEditMode(): void {
    if (editMode.value) exitEditMode();
    else editMode.value = true;
  }

  /** 分类级管理（分类本身是一张表，跟"某个 tag 属于谁"分开）—— 一次只显示一件事 */
  const creatingCategory = ref(false);
  const newCategory = ref('');
  const renamingCategory = ref('');
  const renameTo = ref('');
  const confirmRemove = ref<{ name: string; count: number } | null>(null);
  const categoryBusy = ref(false);
  /** 待确认的"批量删掉这个分类下的词条"（词条真删，分类留着） */
  const deletingCategory = ref<{ name: string; count: number } | null>(null);

  /**
   * **批量删除**这个分类下的词条：先摆出影响范围再确认（跟删分类同一套）。
   * 这是面板上唯一的批量删除入口 —— 逐条删要点 N 次「删」。
   */
  function askDeleteEntries(name: string, count: number): void {
    deletingCategory.value = { name, count };
    creatingCategory.value = false;
    renamingCategory.value = '';
    confirmRemove.value = null;
  }

  function cancelDeleteEntries(): void {
    deletingCategory.value = null;
  }

  async function submitDeleteEntries(): Promise<void> {
    const target = deletingCategory.value;
    if (target === null || categoryBusy.value) return;
    categoryBusy.value = true;
    error.value = '';
    try {
      const result = await deleteCategoryEntries(target.name);
      deletingCategory.value = null;
      // 删掉的东西不可撤销，至少把"删掉了什么"说全（含手改过的有几条）
      hint.value =
        `已从库里删掉 ${result.deleted} 条（分类「${target.name}」留着）` +
        (result.userDeleted > 0 ? ` · 其中 ${result.userDeleted} 条是你手改过的` : '');
      await load();
    } catch (err) {
      error.value = `批量删除失败：${(err as Error).message}`;
    } finally {
      categoryBusy.value = false;
    }
  }

  function startCreateCategory(): void {
    creatingCategory.value = true;
    newCategory.value = '';
    renamingCategory.value = '';
    confirmRemove.value = null;
  }

  function cancelCreateCategory(): void {
    creatingCategory.value = false;
    newCategory.value = '';
  }

  async function submitCreateCategory(): Promise<void> {
    const name = newCategory.value.trim();
    if (name === '' || categoryBusy.value) return;
    categoryBusy.value = true;
    error.value = '';
    try {
      const created = await createCategory(name);
      hint.value = created ? `已新建分类「${name}」` : `已经有一个叫「${name}」的分类了`;
      creatingCategory.value = false;
      newCategory.value = '';
      await load();
    } catch (err) {
      error.value = `新建分类失败：${(err as Error).message}`;
    } finally {
      categoryBusy.value = false;
    }
  }

  function startRenameCategory(name: string): void {
    renamingCategory.value = name;
    renameTo.value = name;
    creatingCategory.value = false;
    confirmRemove.value = null;
  }

  function cancelRenameCategory(): void {
    renamingCategory.value = '';
    renameTo.value = '';
  }

  async function submitRenameCategory(): Promise<void> {
    const from = renamingCategory.value;
    const to = renameTo.value.trim();
    if (from === '' || to === '' || categoryBusy.value) return;
    if (to === from) {
      cancelRenameCategory();
      return;
    }
    categoryBusy.value = true;
    error.value = '';
    try {
      const moved = await renameCategory(from, to);
      hint.value = `「${from}」已改名为「${to}」（${moved} 条词条跟着走）`;
      // 正在筛这个分类：跟着改成新名字，不然筛选条件就指向一个不存在的名字了
      if (category.value === from) category.value = to;
      cancelRenameCategory();
      await load();
    } catch (err) {
      error.value = `改名失败：${(err as Error).message}`;
    } finally {
      categoryBusy.value = false;
    }
  }

  /** 删除是批量破坏性的（可能几万条），所以先摆出影响范围再让人确认 */
  function askRemoveCategory(name: string, count: number): void {
    confirmRemove.value = { name, count };
    creatingCategory.value = false;
    renamingCategory.value = '';
  }

  function cancelRemoveCategory(): void {
    confirmRemove.value = null;
  }

  async function submitRemoveCategory(): Promise<void> {
    const target = confirmRemove.value;
    if (target === null || categoryBusy.value) return;
    categoryBusy.value = true;
    error.value = '';
    try {
      const removed = await deleteCategory(target.name);
      hint.value = `已删掉分类「${target.name}」（${removed} 条词条变回未分类，词条本身没删）`;
      // 正在筛这个分类的话，筛下去就是空的 —— 回到「全部」
      if (category.value === target.name) category.value = '';
      confirmRemove.value = null;
      await load();
    } catch (err) {
      error.value = `删除分类失败：${(err as Error).message}`;
    } finally {
      categoryBusy.value = false;
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
      void loadBundled();
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
    bundled,
    importing,
    importBundled,
    dragKey,
    dropTarget,
    dropIndex,
    sortable,
    editMode,
    toggleEditMode,
    exitEditMode,
    limit,
    hasMore,
    canLoadMore,
    loadMore,
    headerLabel,
    reorderCategories,
    deletingCategory,
    askDeleteEntries,
    cancelDeleteEntries,
    submitDeleteEntries,
    creatingCategory,
    newCategory,
    renamingCategory,
    renameTo,
    confirmRemove,
    categoryBusy,
    startCreateCategory,
    cancelCreateCategory,
    submitCreateCategory,
    startRenameCategory,
    cancelRenameCategory,
    submitRenameCategory,
    askRemoveCategory,
    cancelRemoveCategory,
    submitRemoveCategory,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    onRowDragOver,
    onRowDrop,
    toggleCategory,
    removeCategory,
    onSearchInput,
    pickCategory,
    startEdit,
    cancelEdit,
    saveEdit,
    remove,
  };
}
