<script setup lang="ts">
/**
 * 区块卡片的头部：收起 / 拖动把手 / 颜色 / 标题 / 风格开关 / 不使用 / 计数 / 整块译 / 存 / 删除。
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
  /** 触屏换位（+1 下移 / -1 上移）：拖拽在触摸屏上不触发，这两颗是替代入口 */
  (e: 'move', delta: number): void;
  /** 翻这一整块 */
  (e: 'translate-block'): void;
  /** 把这一块存进区块库（面板会弹出来问名字） */
  (e: 'save-to-library'): void;
  (e: 'toggle-palette'): void;
  /** 草稿写事件 1：这个区块的**属性**变了（标题/颜色/风格/收起/不使用）——父级只发结构 */
  (e: 'structure-changed'): void;
  /** 草稿写事件 2：这个区块**编辑完了**（条目变了）——父级只发这个区块的条目 */
  (e: 'items-committed'): void;
  /** 重新启用了这一块：它之前不进自动译队列，现在得把没译文的条目补排一次 */
  (e: 'enabled-changed'): void;
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

/** 收起 / 展开：只藏块体（条目原样留着），纯显示状态 —— 跟结构一起落盘，刷新后还收着 */
function toggleCollapse(): void {
  props.block.collapsed = !props.block.collapsed;
  emit('structure-changed');
}

/**
 * 不使用 / 重新启用：整块不进输出（内容一条不动）。
 * 除了属性（事件 1），还要单独说一声"启用了" —— 不使用的块不进自动译队列，启用时得补排一次。
 */
function toggleEnabled(): void {
  props.block.enabled = !props.block.enabled;
  emit('structure-changed');
  emit('enabled-changed');
}

/**
 * 允许 / 收回「AI 可以改这一块」（D27）：LLM 的写工具只认 `ai === true` 的块。
 * 纯属性（事件 1），跟颜色 / 标题一样只发结构。
 */
function toggleAi(): void {
  props.block.ai = !props.block.ai;
  emit('structure-changed');
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
    <!-- 收起：块体藏起来、表头留着（条目一条不动，再点一下就展开） -->
    <button
      class="pe-block-fold"
      :class="{ open: !block.collapsed }"
      :title="block.collapsed ? '展开这一块' : '收起这一块（内容还在，只是折起来）'"
      @click.stop="toggleCollapse"
    >
      <!-- 三角是内联 svg，不用 `▾`/`▸` 码位：那些"小三角"字符容器字体里没有字形（画成空框），svg 不挑字体 -->
      <svg class="pe-fold-icon" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
        <path d="M2.2 1.2 8.6 5 2.2 8.8Z" />
      </svg>
    </button>
    <!-- 拖动只认这个把手：整个头部 draggable 的话，点开关/标题时手一抖就会开始拖区块 -->
    <span class="pe-block-grip" draggable="true" title="拖动排序">⠿</span>
    <!-- 触屏：拖不动，改用两颗按钮换位（只在 hover:none 的设备上显示，见样式） -->
    <span class="pe-block-move">
      <button title="这一块上移" @click.stop="emit('move', -1)">↑</button>
      <button title="这一块下移" @click.stop="emit('move', 1)">↓</button>
    </span>
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
    <!-- 不使用：整块进不进输出 —— 和条目双击禁用是同一件事，只是范围是整块。
         拨动开关（不是文字按钮）：它管的是"这一块参不参与"，比"怎么排版"更外一层，所以放在风格开关左边 -->
    <button
      class="pe-block-use"
      :class="{ on: block.enabled }"
      role="switch"
      :aria-checked="block.enabled"
      aria-label="这一块参与输出"
      :title="block.enabled ? '这一块参与输出 —— 点一下不用它（内容留着）' : '这一块不参与输出 —— 点一下重新用它'"
      @click.stop="toggleEnabled"
    >
      <span class="pe-block-use-track"><span class="pe-block-use-knob" /></span>
    </button>
    <!-- 允许 AI 改这一块：LLM 的写工具只认 ai===true 的块（D27）。
         它跟「不使用」一样是块级属性（"这一块交给谁"），所以紧挨着那颗开关放 -->
    <button
      class="pe-block-ai"
      :class="{ on: block.ai }"
      :aria-pressed="block.ai"
      :title="block.ai ? 'AI 可以改这一块 —— 点一下收回' : 'AI 不能改这一块 —— 点一下交给 AI 改'"
      @click.stop="toggleAi"
    >
      AI
    </button>
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

.pe-block-fold {
  flex: none;
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  padding: 0 2px;
  cursor: pointer;
}

/* 收起/展开三角：内联 svg 不挑字体（`▾`/`▸` 这类码位容器里没有字形，会被画成空框）。
   收起 = 右指，展开 = 转 90° 变下指 */
.pe-fold-icon {
  display: block;
  width: 12px;
  height: 12px;
  transition: transform 0.15s ease;
}

.pe-block-fold.open .pe-fold-icon {
  transform: rotate(90deg);
}

.pe-block-fold:hover {
  color: var(--accent, #6ea8fe);
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

/* 「N 条」是表头里唯一宽度会变的字：不钉住的话，每块的条数不一样长，标题就被挤得不一样宽，
   开关 / 风格 / 条数这一簇在块与块之间左右错开（实测 3 条 → 1234 条差 19.7px）。
   给够放 4 位数的定宽 + 右对齐 + 等宽数字：条数变，右簇的列不变 */
.pe-block-count {
  flex: none;
  min-width: 3.8em;
  text-align: right;
  font-variant-numeric: tabular-nums;
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

/* 不使用：拨动开关（不是文字按钮）。
   类名不能叫 `pe-block-off` —— 卡片上"已经不用"那个状态类就是这个名（见 block-card.css），
   开关/卡片共用一套类名，选择器和调试都会撞车。 */
.pe-block-use {
  flex: none;
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  padding: 0 2px;
  cursor: pointer;
}

.pe-block-use-track {
  display: block;
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: 999px;
  background: var(--panel, #1b1e24);
  border: 1px solid var(--line, #2e333d);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.pe-block-use-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--muted, #9aa3b2);
  transition: left 0.15s ease, background 0.15s ease;
}

/* 拨到右边 = 这一块参与输出；拨回左边 = 不用它（卡片同时变虚线 + 变暗，见 block-card.css） */
.pe-block-use.on .pe-block-use-track {
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
}

.pe-block-use.on .pe-block-use-knob {
  left: 12px;
  background: #0b1220;
}

.pe-block-use:hover .pe-block-use-track {
  border-color: var(--accent, #6ea8fe);
}

/* 「允许 AI 改这一块」（D27）：块级开关，开着时用强调色 —— 一眼看出哪些块交给了 AI */
.pe-block-ai {
  flex: none;
  border: 1px solid var(--line, #2e333d);
  border-radius: 4px;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  padding: 0 6px;
  cursor: pointer;
}

.pe-block-ai.on {
  background: var(--accent, #6ea8fe);
  border-color: var(--accent, #6ea8fe);
  color: #0b1220;
}

.pe-block-ai:hover {
  border-color: var(--accent, #6ea8fe);
  color: var(--accent, #6ea8fe);
}

.pe-block-ai.on:hover {
  color: #0b1220;
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

/* 触屏换位按钮：宽屏上藏起来（那儿用拖的），触摸设备上常显 */
.pe-block-move {
  display: none;
  flex: none;
  gap: 2px;
}

.pe-block-move button {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel, #1b1e24);
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 5px 9px;
  cursor: pointer;
}

.pe-block-move button:hover {
  border-color: var(--accent, #6ea8fe);
  color: var(--accent, #6ea8fe);
}

@media (hover: none), (pointer: coarse) {
  .pe-block-move {
    display: inline-flex;
  }

  /* 触摸屏上 HTML5 拖拽根本不触发，手柄是个摆设 —— 换成上面那两颗按钮，别留着占位置 */
  .pe-block-grip {
    display: none;
  }
}

@media (max-width: 720px) {
  /* 头部这一行在手机上放不下：允许换行，并且把每个操作都撑到指头点得准 */
  .pe-block-head {
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px;
  }

  .pe-block-title {
    flex: 1 1 110px;
  }

  .pe-block-dot {
    width: 20px;
    height: 20px;
  }

  .pe-block-modes button {
    font-size: 12px;
    padding: 6px 10px;
  }

  .pe-block-tr,
  .pe-block-ai,
  .pe-block-save {
    font-size: 12px;
    padding: 6px 10px;
  }

  /* 开关也是每天要拨的：26×15 的轨道手指点不准，撑大一档（滑块的行程跟着轨道走） */
  .pe-block-use {
    padding: 4px 6px;
  }

  .pe-block-use-track {
    width: 34px;
    height: 20px;
  }

  .pe-block-use-knob {
    width: 14px;
    height: 14px;
  }

  .pe-block-use.on .pe-block-use-knob {
    left: 17px;
  }

  /* 收起那颗箭头也是入口，跟别的按钮一样撑到指头点得准 */
  .pe-block-fold {
    padding: 4px 6px;
  }

  .pe-fold-icon {
    width: 15px;
    height: 15px;
  }

  .pe-block-del {
    font-size: 18px;
    padding: 4px 8px;
  }

  /* 换位与删除原来只有 25px 高：手指点不准，白占一行 */
  .pe-block-move button,
  .pe-block-del {
    min-height: 30px;
  }
}
</style>
