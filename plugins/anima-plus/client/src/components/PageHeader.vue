<script setup lang="ts">
/**
 * 页头：标题 + 一条「ComfyUI 连不连得上」+ 帮助 / 设置两个入口。
 *
 * 顶栏只留连通性一条：模式、WS、WeiLin 各有自己的去处（设置页 / 依赖提示条），
 * 堆在这里只是一排没人看的小框。
 */
import type { HealthResponse } from '@comfyui-web/shared';

defineProps<{ health: HealthResponse | null }>();

const emit = defineEmits<{ help: []; settings: [] }>();
</script>

<template>
  <header class="header">
    <h1>ComfyUI 轻前端</h1>
    <div class="health" v-if="health">
      <span class="pill" :class="health.comfyui.reachable ? 'ok' : 'bad'">
        ComfyUI {{ health.comfyui.reachable ? '已连接' : '未连接' }}
      </span>
    </div>
    <!-- 帮助：显式展示包内 readme.md（运行前需要装哪些节点包） -->
    <button
      class="help-btn"
      type="button"
      title="帮助（运行前需要装哪些节点包）"
      aria-label="帮助：运行前需要装哪些节点包"
      @click="emit('help')"
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9.3a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .9-1 1.6v.3" />
        <path d="M12 16.7h.01" />
      </svg>
      <span>帮助</span>
    </button>
    <!-- 设置：本插件自己持有配置（存进自己的 ctx.space，宿主不代管） -->
    <button
      class="help-btn"
      type="button"
      title="插件设置（保存在插件自己的空间里）"
      aria-label="插件设置"
      @click="emit('settings')"
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path
          d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"
        />
      </svg>
      <span>设置</span>
    </button>
  </header>
</template>

<style scoped src="../ui.css"></style>
<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
h1 {
  font-size: 20px;
  margin: 0;
}
.health {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.help-btn {
  /* 顶到 header 最右：header 是 flex + wrap，左边 h1、中间状态 pill */
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #1e293b;
  border: 1px solid #334155;
  color: #cbd5e1;
  font-size: 12px;
  cursor: pointer;
}
.help-btn:hover {
  color: #f1f5f9;
  border-color: #475569;
}
.help-btn svg {
  display: block;
}
</style>
