<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { HealthResponse } from '@comfyui-web/shared';
import { api } from '@/api';
import TemplateForm from '@/components/TemplateForm.vue';
import DependencyNotice from '@/components/DependencyNotice.vue';
import HelpPanel from '@/components/HelpPanel.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';
import { useDependencies } from '@/composables/useDependencies';
import { useTemplate } from '@/composables/useTemplate';
import { useJobs } from '@/composables/useJobs';

const health = ref<HealthResponse | null>(null);

/** 帮助面板（显式展示包内 readme.md） */
const helpOpen = ref(false);
/** 设置面板：本插件的设置由自己持有（目录型 tab 的宿主设置页对它只读，见 components/SettingsPanel.vue） */
const settingsOpen = ref(false);
const log = ref<string[]>([]);

function pushLog(line: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  log.value.unshift(`[${t}] ${line}`);
  if (log.value.length > 200) log.value.pop();
}

// 三段状态各自成组：依赖 / 工作流与表单 / 作业与历史。同名解构 → 模板一个字都不用改。
const { deps, depsChecking, currentDeps, depsReady, showDepsProblem, checkDeps } =
  useDependencies(pushLog);
const { template, values, models, stateNote, fatalError, fail, loadTemplate, saveLastState } =
  useTemplate(pushLog);
const {
  status,
  submitting,
  queue,
  queueCount,
  recentAssets,
  recentJobId,
  errorMessage,
  history,
  clearing,
  assetThumbUrl,
  submit,
  cancel,
  reuse,
  clearHistory,
  refreshHistory,
  start,
  stop,
} = useJobs(pushLog, template, values, saveLastState);

// 队列在跑**不锁**表单：提交一回来就能改参数接着排下一条（这是这个插件排队能力的关键）
const canSubmit = computed(() => !!template.value && !submitting.value && depsReady.value);

async function bootstrap(): Promise<void> {
  try {
    health.value = await api.health();
    pushLog(
      `服务就绪 · ComfyUI 模式=${health.value.comfyMode} · 可达=${health.value.comfyui.reachable}`,
    );
  } catch (err) {
    pushLog(`健康检查失败: ${(err as Error).message}`);
  }

  try {
    // 一个插件只有一份工作流定义，不需要先"列模板再挑一个"
    await loadTemplate();
  } catch (err) {
    // 关键：工作流加载失败必须**可见**，否则页面会静默残缺
    // （曾经因为 structuredClone 缺失抛错，只剩描述、没有表单、无人知道为什么）
    fail(`工作流加载失败: ${(err as Error).message}`);
  }

  await refreshHistory();
}

onMounted(() => {
  // 兜底：任何未捕获异常都写进日志，避免"页面残缺但没有任何线索"
  window.addEventListener('error', (e) => {
    pushLog(`✘ 未捕获错误: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined;
    pushLog(`✘ 未处理的 Promise 拒绝: ${r?.message ?? String(e.reason)}`);
  });
  void bootstrap();
  // 依赖检查独立于 bootstrap：即使模板加载失败，也能看到这台机器缺什么
  void checkDeps();
  // 全局任务事件流：一条 SSE 盯住队列里所有任务（连接即发在途快照，刷新页面也能接回来）
  start();
});

onUnmounted(() => {
  // tab 卸载要断开 SSE，否则反复切 tab 会攒下一堆没人读的连接
  stop();
});
</script>


<template>
  <div class="page">
    <header class="header">
      <h1>ComfyUI 轻前端</h1>
      <!-- 顶栏只留「ComfyUI 连不连得上」一条：模式、WS、WeiLin 各有自己的去处
           （设置页 / 依赖提示条），堆在这里只是一排没人看的小框 -->
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
        @click="helpOpen = true"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
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
        @click="settingsOpen = true"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
        </svg>
        <span>设置</span>
      </button>
    </header>

    <div v-if="fatalError" class="banner">
      <strong>页面初始化失败</strong>
      <p>{{ fatalError }}</p>
      <p class="banner-hint">
        打开「运行日志」查看详情；也可尝试刷新页面。若持续失败，请确认后端与模板配置。
      </p>
    </div>

    <!-- pill 撤掉后，提示条只剩"真有问题才冒出来"这一条路；有问题时它自己不给收起 -->
    <DependencyNotice
      v-if="showDepsProblem"
      :deps="deps"
      :checking="depsChecking"
      @refresh="checkDeps(true)"
    />

    <HelpPanel v-if="helpOpen" :deps="deps" @close="helpOpen = false" />

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />

    <main class="layout">
      <section class="card">
        <div class="card-head">
          <h2>参数</h2>
          <!-- 快照状态：让人看得见"刷新不会归零"这件事真的生效了（值来自 last-state.json） -->
          <span v-if="stateNote" class="dim small">{{ stateNote }}</span>
        </div>

        <TemplateForm
          v-if="template"
          :inputs="template.inputs"
          :values="values"
          :models="models"
        />
      </section>

      <section class="card">
        <div class="card-head">
          <h2>队列</h2>
          <span v-if="queueCount" class="dim small">在途 {{ queueCount }} 个</span>
        </div>

        <!-- 开始生成放在队列卡顶部：点了就在同一张卡里看进度，不用在两张卡之间来回找 -->
        <div class="actions">
          <button class="btn primary" :disabled="!canSubmit" @click="submit">
            {{ submitting ? '提交中…' : '加入队列' }}
          </button>
          <span v-if="!depsReady" class="actions-hint bad">
            缺节点 {{ currentDeps?.missing.join('、') }} —— 装好并重启 ComfyUI 后即可生成
          </span>
          <span v-else class="actions-hint">
            提交完就能接着改参数、再排下一条（在途上限＝设置里的「队列深度」）
          </span>
        </div>

        <div class="status-line">
          <strong>状态：</strong><span>{{ status }}</span>
        </div>

        <!-- 一任务一行：队列里可能有好几条在跑/在排，进度条必须逐条画 -->
        <ul v-if="queue.length" class="queue">
          <li v-for="row in queue" :key="row.jobId" class="queue-item">
            <div class="queue-head">
              <span class="pill" :class="row.status">{{ row.label }}</span>
              <span class="mono dim small">{{ row.jobId.slice(0, 12) }}…</span>
              <span v-if="row.waiting" class="dim small">队列第 {{ row.waiting }} 位</span>
              <span v-if="row.seed !== null" class="dim small">种子 {{ row.seed }}</span>
              <button class="btn ghost small" @click="cancel(row.jobId)">取消</button>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: row.percent + '%' }" />
            </div>
            <div class="status-line small">
              <span v-if="row.progress">{{ row.progress.value }} / {{ row.progress.max }} 步</span>
              <span v-else>等上游调度…</span>
              <span v-if="row.progress?.node" class="dim">节点 {{ row.progress.node }}</span>
            </div>
            <p v-if="row.error" class="error">{{ row.error }}</p>
          </li>
        </ul>
        <p v-else class="dim">队列是空的。点「加入队列」提交当前参数。</p>

        <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

        <template v-if="recentAssets.length">
          <div class="status-line small">
            <strong>最近产出：</strong>
            <span class="mono">{{ (recentJobId ?? '').slice(0, 12) }}…</span>
          </div>
          <div class="results">
            <img
              v-for="a in recentAssets"
              :key="a.assetId"
              :src="a.url"
              :alt="a.filename"
              class="result-img"
            />
          </div>
        </template>

        <details class="logbox">
          <summary>运行日志（{{ log.length }}）</summary>
          <pre>{{ log.join('\n') }}</pre>
        </details>
      </section>

      <section class="card wide">
        <div class="card-head">
          <h2>本次会话</h2>
          <div class="head-right">
            <span class="dim small">任务历史不持久化 · 后端重启即清空</span>
            <button
              class="btn ghost small"
              :disabled="clearing || history.length === 0"
              :title="
                history.length === 0
                  ? '没有可清空的记录'
                  : '清空已结束的记录（正在跑的任务会保留）'
              "
              @click="clearHistory"
            >
              {{ clearing ? '清空中…' : '清空' }}
            </button>
          </div>
        </div>
        <!-- 同一个表格：宽屏是表格，窄屏靠 td[data-label] 变成卡片（见样式里的 640px 断点） -->
        <table v-if="history.length" class="table">
          <thead>
            <tr>
              <th>任务</th><th>状态</th><th>种子</th><th>产出</th><th></th>
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
                  <img :src="assetThumbUrl(a.assetId)" class="thumb" loading="lazy" />
                </a>
                <span v-if="!job.assets.length" class="dim">—</span>
              </td>
              <td class="cell-action">
                <button class="btn ghost" @click="reuse(job)">复用参数</button>
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
    </main>
  </div>
</template>

<style scoped src="./App.css"></style>
<style scoped src="./App.controls.css"></style>
