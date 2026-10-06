<script setup lang="ts">
/**
 * 词库面板：**管库**（看 / 搜 / 改译文分类别名 / 删）+ **用库**（点一下插进当前块）。
 *
 * 词库是"一张表两用"（见 server.js 的 `sanitizeTags`）：翻译时按 `en`/别名命中（零请求），
 * 这里按 `categories` 分组。所以面板里改分类不是装饰 —— 分类是"写作时怎么找词"的维度。
 *
 * 插入会**连译文一起带进块**：中文已经在库里了，不用再问接口（这正是词库的价值）。
 */
import { ref, watch } from 'vue';

import { deleteTagEntry, listTags, saveTagEntry, type TagEntry, type TagList } from '../api';

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
        <nav class="pe-lib-cats">
          <button :class="{ on: category === '' }" @click="pickCategory('')">
            全部 <em>{{ data.counts.total }}</em>
          </button>
          <button :class="{ on: category === '__none__' }" @click="pickCategory('__none__')">
            未分类 <em>{{ data.counts.uncategorized }}</em>
          </button>
          <button
            v-for="one in data.categories"
            :key="one.name"
            :class="{ on: category === one.name }"
            @click="pickCategory(one.name)"
          >
            {{ one.name }} <em>{{ one.count }}</em>
          </button>
          <p v-if="data.categories.length === 0" class="pe-lib-tip">
            还没有分类。<br />点条目上的「改」填分类，填过的会出现在这里。
          </p>
        </nav>

        <div class="pe-lib-list">
          <p v-if="error !== ''" class="pe-error">{{ error }}</p>
          <p v-if="loading" class="pe-lib-tip">读取中…</p>
          <p v-else-if="data.tags.length === 0" class="pe-lib-tip">
            没有匹配的条目。手改译文、或在工作区点译文格上的「机」，都会存进这里。
          </p>

          <div v-for="entry in data.tags" :key="entry.key" class="pe-lib-row">
            <div v-if="editing !== entry.key" class="pe-lib-line">
              <span class="pe-lib-en">{{ entry.en }}</span>
              <span class="pe-lib-zh">{{ entry.zh }}</span>
              <span class="pe-lib-src">库</span>
              <span v-for="name in entry.categories" :key="name" class="pe-lib-cat">{{ name }}</span>
              <span v-for="alias in entry.aliases" :key="alias" class="pe-lib-alias">= {{ alias }}</span>
              <span class="pe-lib-actions">
                <button class="pe-btn" :disabled="blocks.length === 0" @click="emit('insert', entry)">插入</button>
                <button class="pe-btn" @click="startEdit(entry)">改</button>
                <button class="pe-btn pe-btn-danger" :disabled="busy === entry.key" @click="remove(entry)">删</button>
              </span>
            </div>

            <div v-else class="pe-lib-edit">
              <!-- 改的时候必须看得见在改哪个词（之前一进编辑态原词就没了） -->
              <div class="pe-lib-edit-head">
                <span class="pe-lib-en">{{ entry.en }}</span>
                <span class="pe-lib-src">库</span>
              </div>
              <label>译文<input v-model="form.zh" class="pe-input" /></label>
              <label>分类<input v-model="form.categories" class="pe-input" placeholder="逗号分隔，如 画质, 光照" /></label>
              <label>别名<input v-model="form.aliases" class="pe-input" placeholder="逗号分隔：输入别名也能命中正名" /></label>
              <div class="pe-lib-actions">
                <button class="pe-btn" :disabled="busy === entry.key" @click="saveEdit(entry)">保存</button>
                <button class="pe-btn" @click="editing = ''">取消</button>
              </div>
            </div>
          </div>
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

.pe-lib-cats {
  flex: 0 0 150px;
  overflow: auto;
  padding: 8px;
  border-right: 1px solid var(--line, #2e333d);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pe-lib-cats button {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
}

.pe-lib-cats button:hover {
  background: var(--panel-2, #22262e);
}

.pe-lib-cats button.on {
  background: var(--panel-2, #22262e);
  color: var(--accent, #6ea8fe);
}

.pe-lib-cats em {
  font-style: normal;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-lib-list {
  flex: 1;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pe-lib-row {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  padding: 6px 8px;
}

.pe-lib-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
}

.pe-lib-en {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.pe-lib-zh {
  color: var(--fg, #e6e8ec);
}

.pe-lib-src {
  border: 1px solid #6ea8fe;
  border-radius: 3px;
  color: #6ea8fe;
  padding: 0 3px;
  font-size: 9px;
  line-height: 13px;
  opacity: 0.85;
}

.pe-lib-cat {
  border-radius: 3px;
  background: var(--panel-2, #22262e);
  color: var(--muted, #9aa3b2);
  padding: 0 5px;
  font-size: 11px;
}

.pe-lib-alias {
  color: var(--muted, #9aa3b2);
  font-size: 11px;
  opacity: 0.75;
}

.pe-lib-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.pe-lib-edit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding-bottom: 5px;
  border-bottom: 1px dashed var(--line, #2e333d);
  font-size: 12px;
}

.pe-lib-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pe-lib-edit label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-lib-edit .pe-input {
  flex: 1;
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

.pe-btn {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.pe-btn:hover:not(:disabled) {
  border-color: var(--accent, #6ea8fe);
}

.pe-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pe-btn-danger:hover:not(:disabled) {
  border-color: var(--danger, #ff7b72);
  color: var(--danger, #ff7b72);
}
</style>
