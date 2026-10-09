<script setup lang="ts">
/**
 * 编辑器的「外壳」：顶栏 + 手机专属的三件套（视图切换 / 底部操作条 / 更多面板）。
 *
 * 为什么要单独一个组件：宽屏能平铺六个按钮，手机上那一行会挤成两行还点不准，
 * 底部又够不着 —— 布局差得太远，索性让「操作入口」按视口分两套，状态与业务留在 App。
 *
 * 两条媒体查询的分工（别混）：
 * - `max-width: 720px` 管**排版**（哪里放得下什么）；
 * - `hover: none` 管**控件**（有没有鼠标 —— 没有 hover 就没有"悬停才出现"的按钮，也没有拖拽）。
 * 窄窗口的桌面浏览器：按窄版排版，但照旧用拖拽和悬停按钮。
 */
import { onUnmounted, ref, watch } from 'vue';

defineProps<{ draftLabel: string; notice: string; view: 'workspace' | 'output' }>();
const emit = defineEmits<{
  (e: 'update:view', view: 'workspace' | 'output'): void;
  (e: 'add-block'): void;
  (e: 'open-preset'): void;
  (e: 'open-lib'): void;
  (e: 'open-block-library'): void;
  (e: 'open-translate'): void;
  (e: 'clear'): void;
}>();

const sheetOpen = ref(false);

/** 手机「更多」里的动作：和顶栏那排是同一批，只是收进了抽屉 */
const sheetItems: { label: string; run: () => void }[] = [
  { label: '预设库…', run: () => emit('open-preset') },
  { label: '词库…', run: () => emit('open-lib') },
  { label: '区块库…', run: () => emit('open-block-library') },
  { label: '翻译…', run: () => emit('open-translate') },
  { label: '清空工作区', run: () => emit('clear') },
];

/** 先关抽屉再执行：面板挂在 App 上，抽屉留着会盖住它 */
function runSheet(run: () => void): void {
  sheetOpen.value = false;
  run();
}

/**
 * Esc 关抽屉。手机上没这个键（那儿有遮罩和「取消」），但窄窗口的桌面浏览器会用到。
 * 监听挂在 window 上，切 tab 会卸载组件 —— 不摘掉监听器就攒着，还会点着已经卸掉的 ref。
 */
watch(sheetOpen, (open) => {
  if (open) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') sheetOpen.value = false;
}
</script>

<template>
  <header class="pe-top">
    <span class="pe-title">工作区</span>
    <span class="pe-draft">{{ draftLabel }}</span>
    <span v-if="notice !== ''" class="pe-notice">{{ notice }}</span>

    <!--
      宽屏：六个动作平铺。**顺序与文案别动** —— scripts/interaction-test.ts 按索引点它们
      （[2] 词库、[3] 区块库），契约测试还断言了「+ 新建区块」这个字符串。
    -->
    <div class="pe-actions">
      <button @click="emit('add-block')">新建区块</button>
      <button @click="emit('open-preset')">预设库…</button>
      <button @click="emit('open-lib')">词库…</button>
      <button @click="emit('open-block-library')">区块库…</button>
      <button @click="emit('open-translate')">翻译…</button>
      <button @click="emit('clear')">清空</button>
    </div>

    <button class="pe-more" title="更多操作" @click="sheetOpen = true">更多…</button>
  </header>

  <!--
    手机：工作区 / 输出 两屏切换。
    窄屏下左右两栏会竖着叠起来，输出区就被压在几十张卡片底下 —— 写完想复制得先滚到底。
  -->
  <div class="pe-viewswitch">
    <button :class="{ on: view === 'workspace' }" @click="emit('update:view', 'workspace')">工作区</button>
    <button :class="{ on: view === 'output' }" @click="emit('update:view', 'output')">输出</button>
  </div>

  <!-- 手机底部操作条：固定在视口底部（拇指够得着）。不做 sticky 顶栏 —— 会跟宿主的顶栏打架 -->
  <div class="pe-bottombar">
    <button class="pe-bottom-main" @click="emit('add-block')">＋ 新建区块</button>
    <button class="pe-bottom-more" title="更多操作" @click="sheetOpen = true">更多…</button>
  </div>

  <div v-if="sheetOpen" class="pe-sheet-mask" @click.self="sheetOpen = false">
    <div class="pe-sheet">
      <button v-for="one in sheetItems" :key="one.label" class="pe-sheet-item" @click="runSheet(one.run)">
        {{ one.label }}
      </button>
      <button class="pe-sheet-item pe-sheet-cancel" @click="sheetOpen = false">取消</button>
    </div>
  </div>
</template>

<style scoped>
.pe-top {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
}

.pe-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted, #9aa3b2);
}

.pe-draft {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-notice {
  flex: 1;
  font-size: 12px;
  color: var(--accent, #6ea8fe);
}

.pe-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.pe-actions button {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 4px 10px;
  cursor: pointer;
}

.pe-actions button:hover {
  border-color: var(--accent, #6ea8fe);
}

/* 手机那三件套在宽屏上不参与排版 */
.pe-more,
.pe-viewswitch,
.pe-bottombar {
  display: none;
}

.pe-more {
  margin-left: auto;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 6px 12px;
  cursor: pointer;
}

.pe-viewswitch {
  gap: 4px;
  margin-top: 10px;
  padding: 3px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
}

.pe-viewswitch button {
  flex: 1;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 13px;
  padding: 7px 0;
  cursor: pointer;
}

.pe-viewswitch button.on {
  background: var(--panel-2, #22262e);
  color: var(--fg, #e6e8ec);
  font-weight: 600;
}

.pe-bottombar {
  gap: 8px;
  /* 固定条：内容区垫的底部内边距在 global.css（否则最后一张卡片会被它盖住） */
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--line, #2e333d);
  background: var(--panel, #1b1e24);
}

.pe-bottombar button {
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 14px;
  padding: 10px 12px;
  cursor: pointer;
}

.pe-bottom-main {
  flex: 1;
}

.pe-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.5);
}

.pe-sheet {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--line, #2e333d);
  border-radius: 14px 14px 0 0;
  background: var(--panel, #1b1e24);
}

.pe-sheet-item {
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 15px;
  padding: 12px;
  text-align: left;
  cursor: pointer;
}

.pe-sheet-cancel {
  border-color: transparent;
  background: transparent;
  color: var(--muted, #9aa3b2);
  text-align: center;
}

@media (max-width: 720px) {
  .pe-top {
    gap: 8px;
    padding: 8px 10px;
  }

  /* 顶栏那排收进「更多…」；入口挪到底部条 */
  .pe-actions {
    display: none;
  }

  .pe-more,
  .pe-viewswitch,
  .pe-bottombar {
    display: flex;
  }
}
</style>
