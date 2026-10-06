<script setup lang="ts">
import { useJobContext } from '../composables/useJob';
import HistoryList from './HistoryList.vue';

const {
  status,
  current,
  running,
  progressPercent,
  STATUS_LABEL,
  formatTime,
  loadStatus,
  history,
  historyTotal,
  clearHistory,
} = useJobContext();
</script>

<template>
  <section class="panel view">
    <div class="statusbar">
      <template v-if="status">
        <span :class="['dot', status.comfyui.reachable ? 'ok' : 'bad']" />
        <span v-if="status.comfyui.reachable">
          ComfyUI {{ status.comfyui.version }} · {{ status.comfyui.device }}
          · 队列 {{ status.comfyui.queue.running }}/{{ status.comfyui.queue.pending }}
        </span>
        <span v-else>连不上 ComfyUI：{{ status.comfyui.error }}</span>
        <span class="sep">|</span>
        <span :class="['dot', status.wsConnected ? 'ok' : 'bad']" />
        <span>{{ status.wsConnected ? 'WS 已连接' : 'WS 未连接' }}</span>
      </template>
      <button type="button" class="mini" @click="loadStatus">刷新</button>
    </div>

    <div v-if="current" class="jobcard">
      <div class="jobhead">
        <strong>{{ STATUS_LABEL[current.status] ?? current.status }}</strong>
        <span class="muted">
          {{ current.values.width }}×{{ current.values.height }} · {{ current.values.steps }} 步 ·
          cfg {{ current.values.cfg }} · seed {{ current.values.seed }}
        </span>
      </div>
      <div class="bar"><div class="fill" :style="{ width: progressPercent + '%' }" /></div>
      <div class="jobmeta">
        <span v-if="current.progress">{{ current.progress.value }}/{{ current.progress.max }}</span>
        <span v-else-if="running" class="muted">等待采样…</span>
        <span v-if="current.node" class="muted">节点 {{ current.node }}</span>
        <span class="muted">{{ formatTime(current.createdAt) }}</span>
      </div>
      <p v-if="current.error" class="error">{{ current.error.code }}: {{ current.error.message }}</p>

      <div v-if="current.assets.length" class="images">
        <figure v-for="asset in current.assets" :key="asset.idx">
          <a :href="asset.url" target="_blank" rel="noreferrer">
            <img :src="asset.url" :alt="asset.filename" loading="lazy" />
          </a>
          <figcaption>
            <span class="muted">{{ (asset.bytes / 1024).toFixed(0) }} KB</span>
            <a :href="asset.url + '?download=1'" download>下载</a>
          </figcaption>
        </figure>
      </div>
      <p v-else-if="current.status === 'succeeded'" class="muted">这个作业没有产出图片。</p>
    </div>

    <div v-else class="empty muted">还没有作业。左边写好提示词点「开始生成」。</div>

    <div class="history-head">
      <h3>历史 <span class="muted">{{ history.length }}/{{ historyTotal }}</span></h3>
      <button v-if="history.length" type="button" class="mini" @click="clearHistory">清空记录</button>
    </div>
    <HistoryList />
  </section>
</template>

<style scoped>
/* 本组件是 .layout 的网格项，min-width 跟着元素走（父组件的 scoped 样式管不到这里） */
.panel {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 14px 16px 16px;
  min-width: 0;
}

.statusbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: #cbd5e1;
  padding-bottom: 10px;
  border-bottom: 1px solid #1e293b;
  margin-bottom: 12px;
}
.statusbar .sep {
  color: #334155;
}
.mini {
  font-size: 12px;
  padding: 2px 8px;
  margin-left: auto;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot.ok {
  background: #22c55e;
}
.dot.bad {
  background: #ef4444;
}

.jobcard {
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 12px;
}
.jobhead {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.jobmeta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  margin-top: 4px;
}
.bar {
  height: 6px;
  background: #1e293b;
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: #38bdf8;
  transition: width 0.3s ease;
}
.muted {
  color: #94a3b8;
  font-size: 12px;
}
.error {
  margin: 10px 0 0;
  color: #fca5a5;
  font-size: 13px;
  white-space: pre-wrap;
}
.empty {
  padding: 24px 0;
  text-align: center;
}

.images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin: 12px 0 0;
}
.images figure {
  margin: 0;
}
.images img {
  width: 100%;
  border-radius: 6px;
  display: block;
  background: #020617;
}
.images figcaption {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 12px;
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 8px;
}
.history-head h3 {
  margin: 0;
  font-size: 14px;
}
</style>
