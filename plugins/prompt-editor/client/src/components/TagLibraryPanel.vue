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
  onSearchInput,
  pickCategory,
  startEdit,
  cancelEdit,
  saveEdit,
  remove,
} = useTagLibrary(props);
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>词库</strong>
        <span class="pe-lib-stat">共 {{ data.counts.total }} 条 · 未分类 {{ data.counts.uncategorized }}</span>
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
      </div>

      <div class="pe-lib-main">
        <TagCategoryNav
          :categories="data.categories"
          :total="data.counts.total"
          :uncategorized="data.counts.uncategorized"
          :active="category"
          @pick="pickCategory"
        />

        <div class="pe-lib-list">
          <p v-if="error !== ''" class="pe-error">{{ error }}</p>
          <p v-if="loading" class="pe-lib-tip">读取中…</p>
          <p v-else-if="data.tags.length === 0" class="pe-lib-tip">
            没有匹配的条目。手改译文、或在工作区点译文格上的「机」，都会存进这里。
          </p>

          <TagLibraryRow
            v-for="entry in data.tags"
            :key="entry.key"
            :entry="entry"
            :target-count="blocks.length"
            :editing="editing === entry.key"
            :busy="busy === entry.key"
            :form="form"
            @insert="(one: TagEntry) => emit('insert', one)"
            @start-edit="startEdit"
            @remove="remove"
            @save="saveEdit"
            @cancel="cancelEdit"
          />
        </div>
      </div>

      <footer class="pe-lib-foot">
        <span v-if="hint !== ''" class="pe-hint">{{ hint }}</span>
        <span class="pe-lib-tip">进库的都是你手动存过的（手改译文 / 点「机」/ 在这里改）—— 不要的点「删」。</span>
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

.pe-lib-tip {
  margin: 0;
  padding: 4px 2px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted, #9aa3b2);
  opacity: 0.85;
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
