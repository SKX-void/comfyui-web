<script setup lang="ts">
/**
 * 「本次会话」：这一轮会话的任务历史（不持久化，后端重启即清空）。
 *
 * 窄屏不复制 DOM（缩略图会请求两次），还是同一个表格换皮：隐藏表头、td 变块、
 * 字段名由 td[data-label] 的 ::before 生成 —— 每行就是一张卡片。见 SessionCard.css 的 640px 那条。
 */
import type { Job } from '@comfyui-web/shared';

defineProps<{
  history: Job[];
  clearing: boolean;
  /** 缩略图地址（父级的 assetThumbUrl：走 /api/assets/:id/thumb，别拉原图） */
  thumbUrl: (assetId: string) => string;
}>();

const emit = defineEmits<{ clear: []; reuse: [job: Job] }>();
</script>

<template>
  <section class="card wide">
    <div class="card-head">
      <h2>本次会话</h2>
      <div class="head-right">
        <span class="dim small">任务历史不持久化 · 后端重启即清空</span>
        <button
          class="btn ghost small"
          :disabled="clearing || history.length === 0"
          :title="
            history.length === 0 ? '没有可清空的记录' : '清空已结束的记录（正在跑的任务会保留）'
          "
          @click="emit('clear')"
        >
          {{ clearing ? '清空中…' : '清空' }}
        </button>
      </div>
    </div>

    <table v-if="history.length" class="table">
      <thead>
        <tr>
          <th>任务</th>
          <th>状态</th>
          <th>种子</th>
          <th>产出</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in history" :key="job.jobId">
          <td class="mono" data-label="任务">{{ job.jobId.slice(0, 12) }}…</td>
          <td data-label="状态"><span class="pill" :class="job.status">{{ job.status }}</span></td>
          <!-- 展示实际落图的种子：用户填 -1 时表单里看不到它，但复现这张图要靠它 -->
          <td class="mono" data-label="种子">
            <template v-if="job.seeds && Object.keys(job.seeds).length">
              {{ Object.values(job.seeds).join(', ') }}
            </template>
            <span v-else class="dim">—</span>
          </td>
          <td class="cell-assets" data-label="产出">
            <a
              v-for="a in job.assets"
              :key="a.assetId"
              :href="a.url"
              target="_blank"
              rel="noreferrer"
              class="thumb-link"
            >
              <img :src="thumbUrl(a.assetId)" class="thumb" loading="lazy" />
            </a>
            <span v-if="!job.assets.length" class="dim">—</span>
          </td>
          <td class="cell-action">
            <button class="btn ghost" @click="emit('reuse', job)">复用参数</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="dim">
      本次会话还没有任务。出图参数会在每次点「加入队列」时记进插件空间（
      <code>last-state.json</code>），刷新页面自动回填；要留档整套工作流时，把「输出格式」切到
      <strong>PNG</strong>，完整工作流会写进图片元数据。
    </p>
  </section>
</template>

<style scoped src="./SessionCard.css"></style>
