<script setup lang="ts">
/**
 * 「加入队列 / 保存状态」两颗按钮 + 缺节点提示。
 *
 * 同一个组件出现两次：
 * - 队列卡顶部 —— 宽屏唯一入口，点完就在同一张卡里看进度；
 * - 参数卡底部 —— **只在竖屏**（`.in-param`，见下方媒体查询）。竖屏下两张卡是分屏切换的，
 *   切到「参数」屏时队列卡整个不显示，出口要是跟着藏起来，填完参数就没法提交了。
 */
defineProps<{
  submitting: boolean;
  savingState: boolean;
  canSubmit: boolean;
  canSaveState: boolean;
  /** 依赖检查是否通过（false 时把缺的节点名报出来，别让人对着禁用按钮猜） */
  depsReady: boolean;
  missing: string[];
}>();

const emit = defineEmits<{ submit: []; save: [] }>();
</script>

<template>
  <div class="actions">
    <button class="btn primary" :disabled="!canSubmit" @click="emit('submit')">
      {{ submitting ? '提交中…' : '加入队列' }}
    </button>
    <!-- 只写快照、不出图：prompt-editor 的跨插件调用拿快照当参数基底，不该为它先排一条真任务 -->
    <button
      class="btn"
      :disabled="!canSaveState"
      title="只把当前参数写进参数快照（last-state.json），不排队、不出图 —— prompt-editor 的跨插件调用读它拿参数基底"
      @click="emit('save')"
    >
      {{ savingState ? '保存中…' : '保存状态' }}
    </button>
    <span v-if="!depsReady" class="hint bad">
      缺节点 {{ missing.join('、') }} —— 装好并重启 ComfyUI 后即可生成
    </span>
  </div>
</template>

<style scoped src="../ui.css"></style>
<style scoped>
.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  flex-wrap: wrap;
}
/* 参数卡里那一份只在竖屏出现（宽屏两张卡并排，队列卡的入口就在右边） */
.actions.in-param {
  display: none;
}
.hint {
  font-size: 12px;
  align-self: center;
  min-width: 0;
}
.hint.bad {
  color: #f87171;
}
@media (max-width: 900px) {
  .actions.in-param {
    display: flex;
  }
}
</style>
