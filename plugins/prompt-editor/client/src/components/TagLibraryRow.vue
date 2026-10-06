<script setup lang="ts">
/**
 * 词库面板里的一行：看（原文/译文/分类/别名 + 插入/改/删）或改（译文/分类/别名表单）。
 *
 * 单独成文件只是为了行数：`form` 就是父级那个 ref 里的对象，这里 v-model 直接改它的字段
 * （保存时父级读到的就是这里改过的值）。
 */
import type { TagEntry } from '../api';

defineProps<{
  entry: TagEntry;
  /** 可插入的目标块数：一个都没有时「插入」不可点 */
  targetCount: number;
  editing: boolean;
  busy: boolean;
  form: { zh: string; categories: string; aliases: string };
}>();
const emit = defineEmits<{
  (e: 'insert', entry: TagEntry): void;
  (e: 'start-edit', entry: TagEntry): void;
  (e: 'remove', entry: TagEntry): void;
  (e: 'save', entry: TagEntry): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <div class="pe-lib-row">
    <div v-if="!editing" class="pe-lib-line">
      <span class="pe-lib-en">{{ entry.en }}</span>
      <span class="pe-lib-zh">{{ entry.zh }}</span>
      <span class="pe-lib-src">库</span>
      <span v-for="name in entry.categories" :key="name" class="pe-lib-cat">{{ name }}</span>
      <span v-for="alias in entry.aliases" :key="alias" class="pe-lib-alias">= {{ alias }}</span>
      <span class="pe-lib-actions">
        <button class="pe-btn" :disabled="targetCount === 0" @click="emit('insert', entry)">插入</button>
        <button class="pe-btn" @click="emit('start-edit', entry)">改</button>
        <button class="pe-btn pe-btn-danger" :disabled="busy" @click="emit('remove', entry)">删</button>
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
        <button class="pe-btn" :disabled="busy" @click="emit('save', entry)">保存</button>
        <button class="pe-btn" @click="emit('cancel')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

/* 下面三条面板本体也有一份：行是独立组件，scoped 样式作用不到对方的节点 */
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
