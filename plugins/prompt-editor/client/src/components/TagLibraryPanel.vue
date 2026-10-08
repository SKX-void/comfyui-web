<script setup lang="ts">
/**
 * 词库面板：**管库**（看 / 搜 / 改译文分类别名 / 删）+ **用库**（点一下插进当前块）。
 *
 * 词库是"一张表两用"（见 server.js 的 `sanitizeTags`）：翻译时按 `en`/别名命中（零请求），
 * 这里按 `categories` 分组。所以面板里改分类不是装饰 —— 分类是"写作时怎么找词"的维度。
 *
 * 插入会**连译文一起带进块**：中文已经在库里了，不用再问接口（这正是词库的价值）。
 * 单行在 TagLibraryRow、分类树在 TagCategoryNav，这里只留数据与请求。
 */
import { computed, watch } from 'vue';

import TagCategoryNav from './TagCategoryNav.vue';
import TagLibraryRow from './TagLibraryRow.vue';
import { type TagEntry } from '../api';
import { useTagLibrary } from '../composables/useTagLibrary';

const props = defineProps<{
  open: boolean;
  /** 可插入的目标块（面板里选） */
  blocks: { id: string; label: string }[];
  /** 工作区里最后碰过的块：打开面板时默认插到它 */
  activeBlockId: string;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'insert', entry: TagEntry): void;
}>();

const {
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
  reorderCategories,
  deletingCategory,
  askDeleteEntries,
  cancelDeleteEntries,
  submitDeleteEntries,
  canLoadMore,
  loadMore,
  headerLabel,
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
} = useTagLibrary(props);

/**
 * 每次打开面板都回到浏览模式。编辑模式把「插入」藏起来了，粘着这个模式的话
 * 打开面板会没有主操作（"我要插一条"是最常见的那件事）—— 编辑是一次有意的动作，从零开始。
 */
watch(
  () => props.open,
  (open) => {
    if (open) exitEditMode();
  },
);

/** 内置表的体积：按钮上要写清楚"这一下要写进去多少" */
const bundledLabel = computed(() =>
  bundled.value === null || !bundled.value.available ? '' : `${(bundled.value.bytes / 1024 / 1024).toFixed(1)}MB`,
);

/** 编辑态里可点的那批分类名（就是左边分类树的名字；「全部 / 未分类」两个哨兵不在里面） */
const knownCategories = computed(() => data.value.categories.map((one) => one.name));
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>词库</strong>
        <span class="pe-lib-stat">{{ headerLabel }}</span>
        <!-- 「读取中…」原来在列表第一行：拖完一行要重新拉数据，那一行插进去就把下面全顶下去，
             松手后列表跳一下。挪到头部，并且**常驻占位**（只切 visibility）—— 出现/消失都不动布局 -->
        <span class="pe-lib-loading" :class="{ on: loading }">读取中…</span>
        <button class="pe-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <div class="pe-lib-bar">
        <input v-model="query" class="pe-input" placeholder="搜英文 / 中文 / 别名" @input="onSearchInput" />
        <label class="pe-lib-target">
          插入到
          <select v-model="targetId" class="pe-input">
            <option v-for="block in blocks" :key="block.id" :value="block.id">{{ block.label }}</option>
          </select>
        </label>
        <!-- 插入随时可用；改/删收进这里（「删」没有二次确认，误触一次这条就没了） -->
        <button
          class="pe-btn pe-lib-mode"
          :class="{ on: editMode }"
          :title="editMode ? '编辑模式：行上出现「改 / 删」，点行上的分类 × 能摘分类' : '浏览模式：只插不改；打开才会出现「改 / 删」'"
          @click="toggleEditMode"
        >
          {{ editMode ? '编辑模式：开' : '编辑模式：关' }}
        </button>
      </div>

      <div class="pe-lib-main">
        <TagCategoryNav
          :categories="data.categories"
          :total="data.counts.total"
          :uncategorized="data.counts.uncategorized"
          :active="category"
          :dragging="dragKey !== ''"
          :drop-target="dropTarget"
          :creating="creatingCategory"
          :new-name="newCategory"
          :renaming="renamingCategory"
          :rename-to="renameTo"
          :confirm="confirmRemove"
          :busy="categoryBusy"
          :edit-mode="editMode"
          :delete-confirm="deletingCategory"
          @pick="pickCategory"
          @reorder-categories="reorderCategories"
          @ask-delete-entries="askDeleteEntries"
          @cancel-delete-entries="cancelDeleteEntries"
          @submit-delete-entries="submitDeleteEntries"
          @drag-over="onDragOver"
          @drag-leave="dropTarget = ''"
          @drop="onDrop"
          @start-create="startCreateCategory"
          @cancel-create="cancelCreateCategory"
          @update:new-name="(value: string) => (newCategory = value)"
          @submit-create="submitCreateCategory"
          @start-rename="startRenameCategory"
          @cancel-rename="cancelRenameCategory"
          @update:rename-to="(value: string) => (renameTo = value)"
          @submit-rename="submitRenameCategory"
          @ask-remove="askRemoveCategory"
          @cancel-remove="cancelRemoveCategory"
          @submit-remove="submitRemoveCategory"
        />

        <div class="pe-lib-list">
          <p v-if="error !== ''" class="pe-error">{{ error }}</p>

          <!-- 空库：给一条"不用自己收集 CSV"的路。导入是手动动作，不在这里自动跑。
               加载中不画空态：打开面板的首帧 `data` 还是空表，画出来就是一闪的"词库是空的" -->
          <div v-if="!loading && data.counts.total === 0" class="pe-lib-empty">
            <p class="pe-lib-tip">词库还是空的。手改译文、或在工作区点译文格上的「机」，都会存进这里。</p>
            <template v-if="bundled !== null && bundled.available">
              <p class="pe-lib-tip">
                也可以先导入内置的 danbooru 机翻表（{{ bundledLabel }}，约 14 万条）—— 一次写进本机 SQLite，
                以后翻译命中它就是零请求。要哪条不要哪条，在下面改分类 / 删掉就行。
              </p>
              <button class="pe-btn" :disabled="importing" @click="importBundled">
                {{ importing ? '导入中…（十几万行，几秒钟）' : '导入内置机翻表' }}
              </button>
            </template>
            <p v-else class="pe-lib-tip">产物里没有内置机翻表（assets/danbooru-zh.csv）—— 先 pnpm build:plugins。</p>
          </div>

          <p v-else-if="!loading && data.tags.length === 0" class="pe-lib-tip">
            没有匹配的条目。手改译文、或在工作区点译文格上的「机」，都会存进这里。
          </p>

          <TagLibraryRow
            v-for="(entry, index) in data.tags"
            :key="entry.key"
            :entry="entry"
            :target-count="blocks.length"
            :editing="editing === entry.key"
            :busy="busy === entry.key"
            :form="form"
            :dragging="dragKey === entry.key"
            :drop-index="dropIndex"
            :index="index"
            :sortable="sortable"
            :edit-mode="editMode"
            :known-categories="knownCategories"
            @insert="(one: TagEntry) => emit('insert', one)"
            @start-edit="startEdit"
            @remove="remove"
            @save="saveEdit"
            @cancel="cancelEdit"
            @drag-start="onDragStart"
            @drag-end="onDragEnd"
            @row-drag-over="onRowDragOver"
            @row-drop="onRowDrop"
            @toggle-category="toggleCategory"
            @remove-category="(name: string) => removeCategory(entry, name)"
          />
          <!-- 加载更多：面板一次只取 300 条，后面的行原来除了搜索没有入口 -->
          <button v-if="canLoadMore" class="pe-btn pe-lib-more" :disabled="loading" @click="loadMore">
            加载更多（已显示 {{ data.tags.length }}）
          </button>
        </div>
      </div>

      <footer class="pe-lib-foot">
        <span v-if="hint !== ''" class="pe-hint">{{ hint }}</span>
        <span class="pe-lib-tip">
          进库的要么是你手动存的（手改译文 / 点「机」/ 在这里改），要么是导入的机翻 —— 不要的点「删」。
        </span>
        <!-- 库里已经有东西时，空态那张卡就不画了；留个小口子给"换了新版 CSV 想再导一遍" -->
        <button
          v-if="data.counts.total > 0 && bundled !== null && bundled.available"
          class="pe-btn pe-btn-quiet"
          :disabled="importing"
          :title="`把产物自带的 danbooru-zh.csv（${bundledLabel}）再导一遍：你改过的条目不会被覆盖`"
          @click="importBundled"
        >
          {{ importing ? '导入中…' : '重导内置机翻表' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.pe-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  z-index: 40;
}

.pe-panel {
  width: min(880px, 94vw);
  height: min(620px, 86vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line, #2e333d);
  border-radius: 10px;
  background: var(--panel, #1b1e24);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}

.pe-panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line, #2e333d);
}

.pe-panel-head strong {
  flex: 1;
}

.pe-close {
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.pe-lib-stat {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

/* 常驻占位：文字一直在，只切 visibility —— 宽度天然留出来，出现/消失都不挤旁边的计数 */
.pe-lib-loading {
  font-size: 11px;
  color: var(--accent, #6ea8fe);
  white-space: nowrap;
  visibility: hidden;
}

.pe-lib-loading.on {
  visibility: visible;
}

.pe-lib-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line, #2e333d);
}

.pe-lib-bar .pe-input {
  flex: 1;
}

.pe-lib-target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
  white-space: nowrap;
}

.pe-lib-target .pe-input {
  flex: 0 0 auto;
  max-width: 200px;
}

.pe-lib-main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.pe-lib-list {
  flex: 1;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 加载更多：列表底部一条，别做成大按钮抢注意力 */
/* 打开时明显变样：这个模式下面「删」就在「插入」旁边 */
.pe-lib-mode {
  font-size: 12px;
  white-space: nowrap;
}

.pe-lib-mode.on {
  border-color: var(--accent, #6ea8fe);
  color: var(--accent, #6ea8fe);
}

.pe-lib-more {
  align-self: center;
  margin-top: 6px;
  font-size: 12px;
}

.pe-lib-tip {
  margin: 0;
  padding: 4px 2px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted, #9aa3b2);
  opacity: 0.85;
}

/* 空库那张卡：左边对齐的一竖排（说明 + 按钮） */
.pe-lib-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 4px;
}

.pe-btn {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
}

.pe-btn:hover:not(:disabled) {
  border-color: var(--accent, #6ea8fe);
}

.pe-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.pe-btn-quiet {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-lib-foot .pe-lib-tip {
  flex: 1;
}

.pe-lib-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--line, #2e333d);
}

.pe-hint {
  flex: 1;
  margin: 0;
  font-size: 12px;
  color: var(--ok, #4ac38a);
}

.pe-error {
  margin: 0;
  padding: 4px 2px;
  font-size: 12px;
  color: var(--danger, #ff7b72);
}

.pe-input {
  min-width: 0;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
}

.pe-input:focus {
  border-color: var(--accent, #6ea8fe);
}
</style>
