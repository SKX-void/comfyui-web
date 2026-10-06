<script setup lang="ts">
/**
 * 一个条目（tag 块 / 句子块）。WeiLin 的 token 块就是这一层：单击改名、双击禁用、单独翻译。
 *
 * 拖动排序不在这里做：组件不声明 drag* 事件，父级的 `@dragstart` 等会**透传到根元素**上，
 * 索引由父级掌握，避免把顺序状态塞进每个块里。
 */
import { computed, nextTick, ref, watch } from 'vue';

import type { Item, Mode } from '../model';

const props = defineProps<{ item: Item; mode: Mode; dragging: boolean; busy: boolean; failed: boolean }>();
const emit = defineEmits<{
  (e: 'commit', text: string): void;
  (e: 'toggle'): void;
  (e: 'remove'): void;
  (e: 'translate'): void;
  /** 译文格改完了：条目变了 → 上层发"这个组编辑完了"那个草稿事件 */
  (e: 'commit-translation'): void;
  /** 点「机」标记：把机器翻的这条存进词库 */
  (e: 'promote'): void;
}>();

/**
 * 译文标记只说一件事：**这条译文在不在词库里**。
 * `库` = 在库里（词库命中 / 你手改手填的 / 点「机」存过的）· `机` = 机器现翻的、还没进库。
 * 不在库里就永远要再问一次接口，所以这个标记值得看。
 */
const SOURCE_MARK: Record<string, string> = { dict: '库', api: '机' };
const sourceMark = computed(() => SOURCE_MARK[props.item.source] ?? '');
const sourceTitle = computed(() => {
  if (props.item.source === 'dict') return '这条译文在词库里（词库命中的，或你手改/存过的）—— 自动译不会再覆盖它';
  if (props.item.source === 'api') return '机器现翻的，**还没进词库**；点一下存进词库';
  return '';
});

function onSourceClick(): void {
  if (props.item.source === 'api') emit('promote');
}

const editing = ref(false);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

/** 译文格也是一个小格：点一下就地编辑，写进 item.translation（跟着草稿/预设一起持久化） */
const editingTranslation = ref(false);
const translationDraft = ref('');
const translationEl = ref<HTMLInputElement | null>(null);

function startEdit(): void {
  if (editing.value) return;
  draft.value = props.item.text;
  editing.value = true;
}

function startTranslationEdit(): void {
  if (editingTranslation.value) return;
  translationDraft.value = props.item.translation;
  editingTranslation.value = true;
}

watch(editing, async (value) => {
  if (!value) return;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
});

watch(editingTranslation, async (value) => {
  if (!value) return;
  await nextTick();
  translationEl.value?.focus();
});

function commit(): void {
  if (!editing.value) return;
  // **读输入框的实时值，不能只读 draft**：v-model 在输入法组字期间不更新
  // （Vue 的 vModelText 里 `if (e.target.composing) return`），而中文输入法敲回车往往就是
  // 提交组字那一下 —— keydown 早于 compositionend，此刻 draft 还是旧文本，改名会被吞掉。
  const next = (inputEl.value?.value ?? draft.value).trim();
  editing.value = false;
  if (next !== props.item.text) emit('commit', next);
}

/** 译文提交：失焦即提交（不留空转），空串就是"没翻译" */
function commitTranslation(): void {
  if (!editingTranslation.value) return;
  const next = (translationEl.value?.value ?? translationDraft.value).trim();
  editingTranslation.value = false;
  if (next === props.item.translation) return;
  props.item.translation = next;
  // 手写的译文就是"人认可的" → 标记 + 写进词库（上层收到 commit-translation 去做）
  props.item.source = 'dict';
  emit('commit-translation');
}

function cancel(): void {
  editing.value = false;
}

function cancelTranslation(): void {
  editingTranslation.value = false;
}

/** 双击禁用/启用：顺手退出编辑态，免得"刚点开的输入框"和禁用态叠在一起 */
function toggle(): void {
  editing.value = false;
  emit('toggle');
}
</script>

<template>
  <!-- 一个条目 = 上下两个小格子：上格原文，下格译文（结构固定，空译文也占位） -->
  <div class="pe-chip-cell">
    <span
      class="pe-chip"
      :class="{ 'pe-chip-off': !item.enabled, 'pe-chip-dragging': dragging }"
      :draggable="!editing"
      title="单击改名 · 双击禁用 · 可拖动排序"
      @click="startEdit"
      @dblclick.stop="toggle"
    >
      <input
        v-if="editing"
        ref="inputEl"
        v-model="draft"
        class="pe-chip-input"
        @click.stop
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      />
      <span v-else class="pe-chip-text">{{ item.text }}</span>

      <button class="pe-chip-btn pe-chip-btn-del" title="删除" @click.stop="emit('remove')">×</button>
    </span>

    <span
      class="pe-chip-translation"
      :class="{
        'pe-chip-translation-empty': item.translation === '',
        'pe-chip-translation-busy': busy,
        'pe-chip-translation-failed': failed,
      }"
      title="单击编辑译文 · 手改的会存进词库，机器翻的不会"
      @click="startTranslationEdit"
    >
      <input
        v-if="editingTranslation"
        ref="translationEl"
        v-model="translationDraft"
        class="pe-chip-input"
        placeholder="译文"
        @click.stop
        @keydown.enter.prevent="commitTranslation"
        @keydown.esc.prevent="cancelTranslation"
        @blur="commitTranslation"
      />
      <span v-else class="pe-chip-text">{{ item.translation === '' ? '译文' : item.translation }}</span>

      <span
        v-if="item.translation !== '' && sourceMark !== ''"
        class="pe-chip-src"
        :class="[`pe-chip-src-${item.source}`, { 'pe-chip-src-clickable': item.source === 'api' }]"
        :title="sourceTitle"
        @click.stop="onSourceClick"
      >
        {{ sourceMark }}
      </span>

      <button
        class="pe-chip-btn"
        :disabled="busy"
        :title="failed ? '上次没翻成（服务不可用或超额），可以手填或再点一次' : '翻译这一条（先查词库）'"
        @click.stop="emit('translate')"
      >
        {{ busy ? '…' : '译' }}
      </button>
    </span>
  </div>
</template>

<style scoped>
.pe-chip-cell {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  max-width: 100%;
}

.pe-chip,
.pe-chip-translation {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  min-height: 24px;
}

.pe-chip {
  background: var(--panel-2, #22262e);
  cursor: text;
  user-select: none;
}

.pe-chip:hover {
  border-color: var(--accent, #6ea8fe);
}

.pe-chip-off {
  opacity: 0.45;
  text-decoration: line-through;
}

.pe-chip-dragging {
  outline: 1px dashed var(--accent, #6ea8fe);
}

.pe-chip-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.pe-chip-input {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  min-width: 60px;
  width: 100%;
  padding: 0;
  outline: none;
}

.pe-chip-btn {
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: 4px;
  opacity: 0;
}

.pe-chip:hover .pe-chip-btn {
  opacity: 1;
}

.pe-chip-btn:hover {
  background: var(--line, #2e333d);
  color: var(--fg, #e6e8ec);
}

.pe-chip-btn-del:hover {
  color: var(--danger, #ff7b72);
}

.pe-chip-translation {
  background: transparent;
  border-style: dashed;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
  cursor: text;
}

.pe-chip-translation-empty {
  opacity: 0.6;
}

/* 翻译中的呼吸 + 失败的留痕：都是"这一刻的状态"，不进数据 */
.pe-chip-translation-busy {
  border-style: solid;
  opacity: 0.9;
}

.pe-chip-translation-failed {
  border-color: #ff7b72;
}

.pe-chip-translation:hover {
  border-color: var(--accent, #6ea8fe);
}

/* 译文来源标记：我（手改/存过，在词库里）· 库（词库命中）· 机（现翻，没进词库） */
.pe-chip-src {
  flex: 0 0 auto;
  padding: 0 3px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 9px;
  line-height: 13px;
  opacity: 0.85;
}

.pe-chip-src-dict {
  color: #6ea8fe;
}

.pe-chip-src-api {
  color: var(--muted, #9aa3b2);
  border-style: dashed;
}

.pe-chip-src-clickable {
  cursor: pointer;
}

.pe-chip-src-clickable:hover {
  color: #d0d6e0;
  border-style: solid;
}
</style>
