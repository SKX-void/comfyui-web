<script setup lang="ts">
/**
 * 条目下格（译文）：单击就地编辑，右上角那个标记只说一件事 —— 这条译文在不在词库里。
 *
 * 单独成文件只是为了行数：它和上格（ItemChip）共享同一个 item 对象，各管各的编辑态。
 * 样式一律自带一份，不依赖"父组件的 scoped 规则能落到子组件根节点上"——
 * 那样会依赖两份样式表在产物里的先后顺序，同一个属性谁赢就说不准了。
 */
import { computed, nextTick, ref, watch } from 'vue';

import type { Item } from '../model';

const props = defineProps<{ item: Item; busy: boolean; failed: boolean }>();
const emit = defineEmits<{
  /** 译文格改完了：条目变了 → 上层发"这个组编辑完了"那个草稿事件 */
  (e: 'commit-translation'): void;
  /** 点「机」标记：把机器翻的这条存进词库 */
  (e: 'promote'): void;
  (e: 'translate'): void;
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

/** 译文格也是一个小格：点一下就地编辑，写进 item.translation（跟着草稿/预设一起持久化） */
const editing = ref(false);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function startEdit(): void {
  if (editing.value) return;
  draft.value = props.item.translation;
  editing.value = true;
}

watch(editing, async (value) => {
  if (!value) return;
  await nextTick();
  inputEl.value?.focus();
});

/** 译文提交：失焦即提交（不留空转），空串就是"没翻译" */
function commit(): void {
  if (!editing.value) return;
  const next = (inputEl.value?.value ?? draft.value).trim();
  editing.value = false;
  if (next === props.item.translation) return;
  props.item.translation = next;
  // 手写的译文就是"人认可的" → 标记 + 写进词库（上层收到 commit-translation 去做）
  props.item.source = 'dict';
  emit('commit-translation');
}

function cancel(): void {
  editing.value = false;
}
</script>

<template>
  <span
    class="pe-chip-translation"
    :class="{
      'pe-chip-translation-empty': item.translation === '',
      'pe-chip-translation-busy': busy,
      'pe-chip-translation-failed': failed,
    }"
    title="单击编辑译文 · 手改的会存进词库，机器翻的不会"
    @click="startEdit"
  >
    <input
      v-if="editing"
      ref="inputEl"
      v-model="draft"
      class="pe-chip-input"
      placeholder="译文"
      @click.stop
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
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
</template>

<style scoped>
.pe-chip-translation {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  min-height: 24px;
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

/* 下面三条上格也有一份：两格是两个组件，scoped 样式作用不到对方的内部节点 */
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

.pe-chip-btn:hover {
  background: var(--line, #2e333d);
  color: var(--fg, #e6e8ec);
}
</style>
