<script setup lang="ts">
/**
 * 竖屏下的「参数 / 队列」切换条 —— 和 prompt-editor 的「工作区 / AI / 输出」同一种分段切换。
 *
 * 只在 ≤900px 出现（两栏塌成一栏的那个断点，见 App.css）：那张卡竖着叠起来之后，
 * 参数表单一长，看进度就得先滚到顶，回来接着填又得滚下去。宽屏两张卡并排，不需要切。
 */
defineProps<{ view: 'param' | 'queue'; queueCount: number }>();

const emit = defineEmits<{ 'update:view': [view: 'param' | 'queue'] }>();
</script>

<template>
  <!-- 不是真 tablist（没有 tabpanel 那套键盘/aria 契约），就是个分段切换：用 aria-pressed 表达选中 -->
  <div class="viewswitch">
    <button
      type="button"
      :aria-pressed="view === 'param'"
      :class="{ on: view === 'param' }"
      @click="emit('update:view', 'param')"
    >
      参数
    </button>
    <button
      type="button"
      :aria-pressed="view === 'queue'"
      :class="{ on: view === 'queue' }"
      @click="emit('update:view', 'queue')"
    >
      队列
      <!-- 在途条数贴在标签上：切到参数屏时也能看见"还有几条在跑" -->
      <span v-if="queueCount" class="count">{{ queueCount }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 宽屏两张卡并排，切换条没有意义 */
.viewswitch {
  display: none;
}

@media (max-width: 900px) {
  .viewswitch {
    display: flex;
    gap: 4px;
    padding: 3px;
    border: 1px solid #1f2937;
    border-radius: 8px;
    background: #111827;
    /* 挂在宿主顶栏下面（.topbar 是 sticky + 高 52px，见 apps/web/src/styles/shell.css）：
       参数表单一长，切一次屏要点到顶上去太远了 */
    position: sticky;
    top: 52px;
    z-index: 9;
    margin-bottom: 12px;
  }

  .viewswitch button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #94a3b8;
    font: inherit;
    font-size: 13px;
    padding: 7px 0;
    cursor: pointer;
  }

  .viewswitch button.on {
    background: #1e293b;
    color: #f1f5f9;
    font-weight: 600;
  }

  .count {
    font-size: 11px;
    font-weight: 400;
    padding: 1px 6px;
    border-radius: 999px;
    background: #4f46e5;
    color: #eef2ff;
  }
}
</style>
