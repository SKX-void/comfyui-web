<script setup lang="ts">
/**
 * 区块卡片的头部：拖动把手 / 颜色 / 标题 / 风格开关 / 计数 / 整块译 / 删除。
 *
 * 单独成文件只是为了行数：它和 BlockCard 拿到的是**同一个 block 对象**，
 * 所以这里照旧直接改 props.block 上的字段（父级的 doc 本来就是 reactive）。
 */
import { MODE_LABEL, reflow, type Block, type Mode } from '../model';

const props = defineProps<{ block: Block; paletteOpen: boolean }>();
const emit = defineEmits<{
  (e: 'remove'): void;
  (e: 'drag-start'): void;
  (e: 'drag-over'): void;
  (e: 'drop'): void;
  (e: 'drag-end'): void;
  /** 翻这一整块 */
  (e: 'translate-block'): void;
  /** 把这一块存进区块库（面板会弹出来问名字） */
  (e: 'save-to-library'): void;
  (e: 'toggle-palette'): void;
  /** 草稿写事件 1：这个区块的**属性**变了（标题/颜色/风格）——父级只发结构 */
  (e: 'structure-changed'): void;
  /** 草稿写事件 2：这个区块**编辑完了**（条目变了）——父级只发这个区块的条目 */
  (e: 'items-committed'): void;
}>();

/**
 * 换**这个区块自己**的风格：先按新规则把块内条目逐个重切（不与其他块发生关系），再改标记。
 * 块与块之间不合并 —— 一个区块就是一个独立的风格单元。
 */
function setBlockMode(mode: Mode): void {
  if (mode === props.block.mode) return;
  props.block.items = reflow(props.block.items, props.block.mode, mode);
  props.block.mode = mode;
  // 风格挂在区块属性上（事件 1），重切又改了条目（事件 2）——两个都得发
  emit('structure-changed');
  emit('items-committed');
}
</script>

<template>
  <header
    class="pe-block-head"
    @dragstart="emit('drag-start')"
    @dragover.prevent="emit('drag-over')"
    @drop.prevent="emit('drop')"
    @dragend="emit('drag-end')"
  >
    <!-- 拖动只认这个把手：整个头部 draggable 的话，点开关/标题时手一抖就会开始拖区块 -->
    <span class="pe-block-grip" draggable="true" title="拖动排序">⠿</span>
    <button
      class="pe-block-dot"
      :style="{ background: block.color }"
      title="改颜色"
      @click.stop="emit('toggle-palette')"
    />
    <!-- @change 而不是 @input：标题也是"编辑完"才发结构（失焦/回车触发 change） -->
    <input
      v-model="block.title"
      class="pe-block-title"
      placeholder="区块标题"
      @change="emit('structure-changed')"
    />
    <!-- 风格开关挂在区块自己身上：每个区块各选 tag 串还是自然语言句子，互不影响 -->
    <div class="pe-block-modes" title="这个区块的风格">
      <button
        v-for="option in (['tag', 'text'] as Mode[])"
        :key="option"
        :class="{ active: block.mode === option }"
        @click.stop="setBlockMode(option)"
      >
        {{ MODE_LABEL[option] }}
      </button>
    </div>
    <span class="pe-block-count">{{ block.items.length }} 条</span>
    <button class="pe-block-tr" title="翻译这一整块（先查词库）" @click.stop="emit('translate-block')">译</button>
    <button class="pe-block-save" title="把这一块存进区块库" @click.stop="emit('save-to-library')">存</button>
    <button class="pe-block-del" title="删除区块" @click="emit('remove')">×</button>
  </header>
</template>

<style scoped>
.pe-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--panel-2, #22262e);
  border-bottom: 1px solid var(--line, #2e333d);
}

.pe-block-grip {
  flex: none;
  cursor: grab;
  color: var(--muted, #9aa3b2);
  user-select: none;
  line-height: 1;
}

.pe-block-modes {
  flex: none;
  display: inline-flex;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  overflow: hidden;
}

.pe-block-modes button {
  border: none;
  background: var(--panel, #1b1e24);
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}

.pe-block-modes button.active {
  background: var(--accent, #6ea8fe);
  color: #0b1220;
  font-weight: 600;
}

.pe-block-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  flex: none;
  padding: 0;
}

.pe-block-title {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  outline: none;
}

.pe-block-count {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
  white-space: nowrap;
}

.pe-block-tr {
  border: 1px solid var(--line, #2e333d);
  border-radius: 4px;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  padding: 0 6px;
  cursor: pointer;
}

.pe-block-tr:hover,
.pe-block-save:hover {
  border-color: var(--accent, #6ea8fe);
  color: var(--accent, #6ea8fe);
}

/* 「存」跟「译」同一个样式盒子：一行小按钮，别抢标题的宽度 */
.pe-block-save {
  border: 1px solid var(--line, #2e333d);
  border-radius: 4px;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  padding: 0 6px;
  cursor: pointer;
}

.pe-block-del {
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.pe-block-del:hover {
  color: var(--danger, #ff7b72);
}
</style>
