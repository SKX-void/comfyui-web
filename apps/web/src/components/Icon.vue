<script setup lang="ts">
/**
 * 极简内联图标集。
 *
 * 为什么不引图标库：这个外壳本身是「用 import map 共享一份 vue」的最小宿主，
 * 目前只用到个位数图标，引一个库 = 多一个依赖 + 多一份 bundle（而且当前环境装新包要联网）。
 * 这里一个图标一条 `<path>`，加图标就是往 ICONS 里加一行。
 *
 * 图标统一 24×24 视框、stroke 描边、颜色跟随 `currentColor`（所以 hover 变色不用额外处理）。
 * 以后真要用整套图标（例如按插件清单里的 `icon` 字段给 tab 配图 —— 清单里已经有这个字段了），
 * 换成 `lucide-vue-next` 时本组件的 props 形状（name/size）可以原样保留。
 */
const ICONS: Record<string, string> = {
  /** 设置：三条滑轨 + 旋钮（sliders）。半径 2.4 的圆由两段半圆弧拼成，缺口刚好让开滑轨。 */
  settings:
    'M4 7h3.2M12 7h8' +
    'M4 12h9.2M18 12h2' +
    'M4 17h1.2M10 17h10' +
    'M9.6 4.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8Z' +
    'M15.6 9.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8Z' +
    'M7.6 14.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8Z',
};

const props = withDefaults(
  defineProps<{
    /** ICONS 里的键；写错不报错，只是画不出来（图标不该让整页崩） */
    name: string;
    size?: number;
    strokeWidth?: number;
  }>(),
  { size: 18, strokeWidth: 1.8 },
);
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="props.strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="ICONS[props.name] ?? ''" />
  </svg>
</template>
