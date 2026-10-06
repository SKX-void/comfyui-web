<script setup lang="ts">
/**
 * 「默认Anima」主界面。
 *
 * 三块：左边的表单（工作流暴露出来的参数）、右边的当前作业（进度/结果图）、下面的历史。
 * 所有数据都来自本插件自己的路由（/api/p/anima-example/*），没有反代、没有跨源。
 *
 * 这里只留布局与组合：状态在 composables/useJob.ts，界面区块在 components/ 下。
 * 每个子组件只有一个根元素 —— 不给自己加包裹层、也不给 DOM 加 fragment 锚点。
 */
import { provideJob, useJob } from './composables/useJob';
import JobForm from './components/JobForm.vue';
import JobView from './components/JobView.vue';

provideJob(useJob());
</script>

<template>
  <div class="layout">
    <!-- ── 左：表单 ─────────────────────────────────────────────── -->
    <JobForm />

    <!-- ── 右：状态 + 当前作业 ───────────────────────────────────── -->
    <JobView />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  /* 两列都必须能收缩：表单里最长的模型名有 50+ 字符，
     <select> 的固有最小宽度等于最长选项，写成 minmax(320px, 420px) 会被顶破 */
  grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.layout > * {
  min-width: 0;
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
