<script setup lang="ts">
/**
 * 一个条目（tag 块 / 句子块）的上格：单击改名、双击禁用。
 * 下格（译文）在 ItemTranslationCell —— 两格共享同一个 item，各管各的编辑态。
 *
 * 拖动不在这里做：组件不声明 drag* 事件，父级的 `@dragstart` 等会**透传到根元素**上，
 * 索引与落点由父级掌握（条目能拖到**别的块**去，状态留在这一层就没法跨块了）。
 */
import { nextTick, ref, watch } from 'vue';

import ItemTranslationCell from './ItemTranslationCell.vue';
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
  /** 触屏拖拽起手：⠿ 把手按下，父级接管 Pointer Events（见 useTouchItemDrag） */
  (e: 'touch-drag-start', event: PointerEvent): void;
}>();

const editing = ref(false);
const draft = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function startEdit(): void {
  if (editing.value) return;
  draft.value = props.item.text;
  editing.value = true;
}

watch(editing, async (value) => {
  if (!value) return;
  await nextTick();
  inputEl.value?.focus();
  inputEl.value?.select();
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

function cancel(): void {
  editing.value = false;
}

/** 双击禁用/启用：顺手退出编辑态，免得"刚点开的输入框"和禁用态叠在一起 */
function toggle(): void {
  editing.value = false;
  emit('toggle');
}

/**
 * ⠿ 把手按下：触屏拖拽的起手。桌面（鼠标）不从这里走 —— 鼠标拖整条 chip 的 HTML5 drag，
 * 这个把手在 hover:hover 的设备上也不显示（见样式）。
 */
function onGripPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse') return;
  emit('touch-drag-start', event);
}
</script>

<template>
  <!-- 一个条目 = 上下两个小格子：上格原文，下格译文（结构固定，空译文也占位） -->
  <div class="pe-chip-cell">
    <span
      class="pe-chip"
      :class="{ 'pe-chip-off': !item.enabled, 'pe-chip-dragging': dragging }"
      :draggable="!editing"
      title="单击改名 · 双击禁用 · 可拖动排序（触屏拖 ⠿ 把手）"
      @click="startEdit"
      @dblclick.stop="toggle"
    >
      <span class="pe-chip-grip" title="拖动排序" @click.stop @pointerdown="onGripPointerDown">⠿</span>
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

      <!--
        触屏（hover: none）：双击禁用不成立，所以换成明摆着的按钮。
        宽屏上藏起来 —— 那儿双击更顺手，多一排按钮只是噪音。
      -->
      <span class="pe-chip-tools">
        <button
          class="pe-chip-tool"
          :title="item.enabled ? '禁用这一条（不进输出）' : '启用这一条'"
          @click.stop="toggle"
        >
          {{ item.enabled ? '禁' : '启' }}
        </button>
      </span>

      <button class="pe-chip-btn pe-chip-btn-del" title="删除" @click.stop="emit('remove')">×</button>
    </span>

    <ItemTranslationCell
      :item="item"
      :busy="busy"
      :failed="failed"
      @commit-translation="emit('commit-translation')"
      @promote="emit('promote')"
      @translate="emit('translate')"
    />
  </div>
</template>

<style scoped>
.pe-chip-cell {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  max-width: 100%;
}

.pe-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  min-height: 24px;
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

/* 触屏拖拽把手：桌面用 HTML5 拖整条 chip，触屏拖不动，用这个把手走 Pointer Events。
   默认隐藏 —— 只有没有 hover 的触摸设备才显示，免得和桌面的"拖整条"打架 */
.pe-chip-grip {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  min-height: 24px;
  color: var(--muted, #9aa3b2);
  cursor: grab;
  user-select: none;
  /* 关键：告诉浏览器"这条手势我们自己处理"，不然手指一动页面就滚走，拖拽立刻被取消 */
  touch-action: none;
  font-size: 13px;
  line-height: 1;
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
  /* 悬停才出现的东西不该占着点击位：opacity 只是看不见，挡在 chip 上照样点得到（误删就是这么来的） */
  visibility: hidden;
}

.pe-chip:hover .pe-chip-btn {
  visibility: visible;
  opacity: 1;
}

.pe-chip-btn:hover {
  background: var(--line, #2e333d);
  color: var(--fg, #e6e8ec);
}

.pe-chip-btn-del:hover {
  color: var(--danger, #ff7b72);
}

/* 触屏专属的那一排（禁用 / 启用）：默认不显示，见下面的 hover: none */
.pe-chip-tools {
  display: none;
  flex: none;
  gap: 2px;
}

.pe-chip-tool {
  border: 1px solid var(--line, #2e333d);
  border-radius: 4px;
  background: var(--panel, #1b1e24);
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 5px 6px;
  cursor: pointer;
}

@media (hover: none), (pointer: coarse), (max-width: 720px) {
  .pe-chip-tools {
    display: inline-flex;
  }

  .pe-chip-grip {
    display: inline-flex;
  }

  /* 「×」和这一排原来只在悬停时出现（opacity: 0）—— 触摸屏上不悬停，等于没有删除入口。
     顺手把它们撑到指头点得准：它们原来只有 19×21 */
  .pe-chip-btn,
  .pe-chip-tool {
    visibility: visible;
    opacity: 1;
    min-width: 28px;
    min-height: 28px;
    padding: 5px 6px;
  }

  /* 删除在触屏上要一眼认出来：加个危险色边框，再和旁边的按钮隔开一点，别误按 */
  .pe-chip-btn-del {
    min-width: 30px;
    min-height: 30px;
    border: 1px solid var(--danger, #ff7b72);
    color: var(--danger, #ff7b72);
    font-size: 16px;
    margin-left: 4px;
  }
}

/* 窄桌面窗口（鼠标）：上面那排触屏按钮照给，但 ⠿ 把手不显示 —— 鼠标还是拖整条 chip */
@media (hover: hover) and (pointer: fine) {
  .pe-chip-grip {
    display: none;
  }
}

@media (max-width: 720px) {
  .pe-chip {
    min-height: 30px;
    padding: 4px 4px 4px 8px;
  }
}
</style>
