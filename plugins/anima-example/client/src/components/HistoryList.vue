<script setup lang="ts">
import { useJobContext } from '../composables/useJob';

const { history, current, STATUS_LABEL, formatTime, loadFromHistory } = useJobContext();
</script>

<template>
  <ul class="history">
    <li v-for="job in history" :key="job.jobId" :class="{ active: job.jobId === current?.jobId }">
      <button type="button" class="history-item" @click="loadFromHistory(job)">
        <img v-if="job.assets.length" :src="job.assets[0]?.url" alt="" loading="lazy" />
        <span v-else class="thumb-placeholder" />
        <span class="history-text">
          <span :class="['tag', job.status]">{{ STATUS_LABEL[job.status] ?? job.status }}</span>
          <span class="muted">{{ formatTime(job.createdAt) }} · {{ job.values.steps }}步 · {{ job.values.width }}×{{ job.values.height }}</span>
          <span class="prompt-preview">{{ job.values.description || job.values.positive }}</span>
        </span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.history {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
}
.history li.active .history-item {
  border-color: #38bdf8;
}
.history-item {
  display: flex;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  align-items: center;
}
.history-item img,
.thumb-placeholder {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  flex: 0 0 auto;
  background: #020617;
}
.history-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.prompt-preview {
  font-size: 12px;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #1e293b;
  align-self: flex-start;
}
.tag.succeeded {
  background: #14532d;
  color: #bbf7d0;
}
.tag.failed {
  background: #7f1d1d;
  color: #fecaca;
}
.tag.running {
  background: #0c4a6e;
  color: #bae6fd;
}
.tag.canceled {
  background: #3f3f46;
  color: #e4e4e7;
}
.muted {
  color: #94a3b8;
  font-size: 12px;
}
</style>
