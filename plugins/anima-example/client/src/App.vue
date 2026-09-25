<script setup lang="ts">
/**
 * 「默认Anima」主界面。
 *
 * 三块：左边的表单（工作流暴露出来的参数）、右边的当前作业（进度/结果图）、下面的历史。
 * 所有数据都来自本插件自己的路由（/api/p/anima-example/*），没有反代、没有跨源。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

import {
  api,
  subscribeJob,
  TERMINAL_STATUSES,
  type Job,
  type JobEventType,
  type PluginOptions,
  type PluginStatus,
} from './api';
import SettingsPanel from './SettingsPanel.vue';

const options = ref<PluginOptions | null>(null);
const status = ref<PluginStatus | null>(null);
const loadError = ref('');
/** 设置面板：本插件的设置由自己持有（见 SettingsPanel.vue），宿主设置页对它只读 */
const settingsOpen = ref(false);

/**
 * 护栏上下限的兜底值：`/options` 还没回来时就用它渲染输入框的 min/max。
 * 必须与后端 `SAFETY` 一致 —— 契约测试会核对渲染出来的 max。
 */
const LIMIT_FALLBACK = { minSteps: 1, maxSteps: 32, minSide: 64, maxSide: 1216 };
const limits = computed(() => options.value?.limits ?? LIMIT_FALLBACK);
const submitBusy = ref(false);
const current = ref<Job | null>(null);
const history = ref<Job[]>([]);
const historyTotal = ref(0);

let unsubscribe: (() => void) | null = null;

const form = reactive({
  description: '',
  positive: '',
  negative: '',
  randomSeed: true,
  seed: 0,
  steps: 20,
  cfg: 7,
  sampler: 'euler',
  scheduler: 'simple',
  width: 1024,
  height: 1024,
  batch: 1,
  rotation: 'none',
  lora: '',
  loraStrength: 1,
  unet: '',
  clip: '',
  vae: '',
});

const SIZE_PRESETS = [
  { label: '832×1216', width: 832, height: 1216 },
  { label: '1216×832', width: 1216, height: 832 },
  { label: '1024²', width: 1024, height: 1024 },
  { label: '768×1024', width: 768, height: 1024 },
  { label: '512×768', width: 512, height: 768 },
];

/**
 * 与后端 `joinPrompt()`（plugins/anima-example/server.js）**逐字一致**的拼接预览。
 * 两边必须同步改，否则这里显示的不是真正发出去的东西。
 */
const joinedPrompt = computed(() =>
  [form.description, form.positive]
    .map((text) => String(text ?? '').trim().replace(/^[,\s]+/, '').replace(/[,\s]+$/, ''))
    .filter((text) => text !== '')
    .join(', '),
);
const running = computed(
  () => current.value !== null && !TERMINAL_STATUSES.includes(current.value.status),
);
const canSubmit = computed(() => joinedPrompt.value !== '' && !submitBusy.value && !running.value);
const progressPercent = computed(() => {
  const p = current.value?.progress;
  if (!p || !p.max) return 0;
  return Math.min(100, Math.round((p.value / p.max) * 100));
});

const STATUS_LABEL: Record<string, string> = {
  created: '已创建',
  queued: '排队中',
  running: '生成中',
  succeeded: '完成',
  failed: '失败',
  canceled: '已取消',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 ComfyUI 报回来的工作流默认值灌进表单 */
function applyDefaults(o: PluginOptions): void {
  const d = o.defaults;
  form.description = d.description ?? '';
  form.positive = d.positive;
  form.negative = d.negative;
  form.seed = d.seed;
  form.steps = d.steps;
  form.cfg = d.cfg;
  form.sampler = d.sampler;
  form.scheduler = d.scheduler;
  form.width = d.width;
  form.height = d.height;
  form.batch = d.batch;
  form.rotation = d.rotation ?? 'none';
  form.lora = d.lora ?? '';
  form.loraStrength = d.loraStrength ?? 1;
  form.unet = d.unet ?? '';
  form.clip = d.clip ?? '';
  form.vae = d.vae ?? '';
}

async function loadOptions(): Promise<void> {
  try {
    const o = await api.options();
    options.value = o;
    applyDefaults(o);
    loadError.value = o.reachable ? '' : 'ComfyUI 的 /object_info 拉不到，模型下拉是空的（仍可手填）。';
  } catch (err) {
    loadError.value = `读取选项失败：${message(err)}`;
  }
}

async function loadStatus(): Promise<void> {
  try {
    status.value = await api.status();
  } catch (err) {
    loadError.value = `读取状态失败：${message(err)}`;
  }
}

async function refreshHistory(): Promise<void> {
  try {
    const r = await api.listJobs(20);
    history.value = r.items;
    historyTotal.value = r.total;
  } catch (err) {
    loadError.value = `读取历史失败：${message(err)}`;
  }
}

/** 订阅一个作业的 SSE，把事件并进 `current` */
function watchJob(jobId: string): void {
  unsubscribe?.();
  current.value = null;
  unsubscribe = subscribeJob(jobId, (type: JobEventType, data) => {
    const job = current.value;
    if (type === 'snapshot') {
      current.value = data as unknown as Job;
      return;
    }
    if (!job || job.jobId !== jobId) return;
    if (type === 'started') job.status = 'running';
    if (type === 'progress') job.progress = data.progress as Job['progress'];
    if (type === 'node') job.node = (data.node as string | null) ?? null;
    if (type === 'queued') job.status = 'queued';
    if (type === 'completed') {
      job.status = 'succeeded';
      job.assets = (data.assets as Job['assets']) ?? [];
      void refreshHistory();
    }
    if (type === 'error') {
      job.status = 'failed';
      job.error = (data.error as Job['error']) ?? null;
      void refreshHistory();
    }
    if (type === 'canceled') {
      job.status = 'canceled';
      void refreshHistory();
    }
  });
}

async function submit(): Promise<void> {
  submitBusy.value = true;
  loadError.value = '';
  try {
    const created = await api.createJob({
      description: form.description,
      positive: form.positive,
      negative: form.negative,
      seed: form.randomSeed ? -1 : Number(form.seed),
      steps: Number(form.steps),
      cfg: Number(form.cfg),
      sampler: form.sampler,
      scheduler: form.scheduler,
      width: Number(form.width),
      height: Number(form.height),
      batch: Number(form.batch),
      rotation: form.rotation,
      lora: form.lora,
      loraStrength: Number(form.loraStrength),
      unet: form.unet,
      clip: form.clip,
      vae: form.vae,
    });
    watchJob(created.jobId);
    void loadStatus();
  } catch (err) {
    loadError.value = `提交失败：${message(err)}`;
  } finally {
    submitBusy.value = false;
  }
}

async function cancel(): Promise<void> {
  if (!current.value) return;
  try {
    await api.cancelJob(current.value.jobId);
  } catch (err) {
    loadError.value = `取消失败：${message(err)}`;
  }
}

/** 点历史：把参数灌回表单，并把它的图显示在右边 */
function loadFromHistory(job: Job): void {
  // 在跑的作业要重新订阅，否则刷新页面后点进来只能看到一条不动的记录
  if (!TERMINAL_STATUSES.includes(job.status)) {
    loadValues(job);
    watchJob(job.jobId);
    return;
  }
  unsubscribe?.();
  unsubscribe = null;
  current.value = job;
  loadValues(job);
}

/** 把作业的参数灌回表单 */
function loadValues(job: Job): void {
  form.description = job.values.description;
  form.positive = job.values.positive;
  form.negative = job.values.negative;
  form.randomSeed = false;
  form.seed = job.values.seed;
  form.steps = job.values.steps;
  form.cfg = job.values.cfg;
  form.sampler = job.values.sampler;
  form.scheduler = job.values.scheduler;
  form.width = job.values.width;
  form.height = job.values.height;
  form.batch = job.values.batch;
  if (job.values.rotation) form.rotation = job.values.rotation;
  if (job.values.lora) form.lora = job.values.lora;
  if (job.values.loraStrength !== null) form.loraStrength = job.values.loraStrength;
  if (job.values.unet) form.unet = job.values.unet;
  if (job.values.clip) form.clip = job.values.clip;
  if (job.values.vae) form.vae = job.values.vae;
}

async function clearHistory(): Promise<void> {
  if (!window.confirm('清空历史记录？图片文件不会被删除。')) return;
  await api.clearJobs();
  current.value = null;
  await refreshHistory();
}

function rollSeed(): void {
  form.seed = Math.floor(Math.random() * 2 ** 53);
  form.randomSeed = false;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

onMounted(async () => {
  await Promise.all([loadOptions(), loadStatus(), refreshHistory()]);
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <div class="layout">
    <!-- ── 左：表单 ─────────────────────────────────────────────── -->
    <section class="panel form">
      <header class="panel-head">
        <h2>默认Anima</h2>
        <span v-if="options" class="badge">工作流 {{ options.workflow.nodes }} 节点 · {{ options.workflow.file }}</span>
        <!-- 设置：本插件自己持有配置（存进自己的 ctx.space，宿主不代管） -->
        <button
          class="mini"
          type="button"
          style="margin-left: auto"
          title="插件设置（保存在插件自己的空间里）"
          @click="settingsOpen = true"
        >
          设置
        </button>
      </header>

      <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />

      <label class="field">
        <span>描述提示词</span>
        <textarea v-model="form.description" rows="5" placeholder="1girl, solo, blue hair, looking at viewer" />
      </label>

      <details class="field">
        <summary>正向提示词（质量 / 风格）</summary>
        <textarea v-model="form.positive" rows="5" />
      </details>

      <details class="field">
        <summary>负向提示词</summary>
        <textarea v-model="form.negative" rows="5" />
      </details>

      <p v-if="joinedPrompt" class="joined" :title="joinedPrompt">
        <span class="muted">拼给 ComfyUI：</span>{{ joinedPrompt }}
      </p>

      <div class="field">
        <span>尺寸 <span class="muted">（{{ limits.minSide }}~{{ limits.maxSide }}）</span></span>
        <div class="row">
          <input v-model.number="form.width" type="number" :min="limits.minSide" :max="limits.maxSide" step="8" />
          <span class="times">×</span>
          <input v-model.number="form.height" type="number" :min="limits.minSide" :max="limits.maxSide" step="8" />
          <label class="inline">
            批量
            <input v-model.number="form.batch" type="number" min="1" max="8" class="tiny" />
          </label>
        </div>
        <div class="presets">
          <button v-for="p in SIZE_PRESETS" :key="p.label" type="button" @click="form.width = p.width; form.height = p.height">
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="grid3">
        <label class="field">
          <span>步数 <span class="muted">（≤{{ limits.maxSteps }}）</span></span>
          <input v-model.number="form.steps" type="number" :min="limits.minSteps" :max="limits.maxSteps" />
        </label>
        <label class="field">
          <span>CFG</span>
          <input v-model.number="form.cfg" type="number" min="0" max="30" step="0.1" />
        </label>
        <div class="field">
          <span>种子</span>
          <div class="row">
            <input v-model.number="form.seed" type="number" :disabled="form.randomSeed" />
            <button type="button" title="随机" @click="rollSeed">🎲</button>
          </div>
          <label class="inline"><input v-model="form.randomSeed" type="checkbox" /> 每次随机</label>
        </div>
      </div>

      <div class="grid2">
        <label class="field">
          <span>采样器</span>
          <select v-model="form.sampler">
            <option v-for="s in options?.sampler ?? []" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="field">
          <span>调度器</span>
          <select v-model="form.scheduler">
            <option v-for="s in options?.scheduler ?? []" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </div>

      <div v-if="options?.defaults.hasLoraNode" class="field">
        <span>LoRA · 强度 {{ Number(form.loraStrength).toFixed(2) }}</span>
        <select v-model="form.lora" :title="form.lora">
          <option v-for="l in options?.lora ?? []" :key="l" :value="l">{{ l }}</option>
        </select>
        <input v-model.number="form.loraStrength" type="range" min="0" max="1" step="0.05" class="range" />
      </div>

      <label v-if="options?.defaults.hasRotateNode" class="field">
        <span>旋转</span>
        <select v-model="form.rotation">
          <option v-for="r in options?.rotation ?? []" :key="r" :value="r">{{ r }}</option>
        </select>
      </label>

      <details class="field">
        <summary>模型（UNET / CLIP / VAE）</summary>
        <label class="field">
          <span>UNET（{{ options?.unet.length ?? 0 }} 个可选）</span>
          <select v-model="form.unet" :title="form.unet">
            <option v-for="m in options?.unet ?? []" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
        <label class="field">
          <span>CLIP（{{ options?.clip.length ?? 0 }} 个可选）</span>
          <select v-model="form.clip" :title="form.clip">
            <option v-for="m in options?.clip ?? []" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
        <label class="field">
          <span>VAE（{{ options?.vae.length ?? 0 }} 个可选）</span>
          <select v-model="form.vae" :title="form.vae">
            <option v-for="m in options?.vae ?? []" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </details>

      <div class="actions">
        <button class="primary" type="button" :disabled="!canSubmit" @click="submit">
          {{ running ? '生成中…' : '开始生成' }}
        </button>
        <button v-if="running" type="button" @click="cancel">打断</button>
        <span v-if="current" class="jobid" :title="current.jobId">{{ current.jobId.slice(0, 8) }}</span>
      </div>

      <p v-if="loadError" class="error">{{ loadError }}</p>
    </section>

    <!-- ── 右：状态 + 当前作业 ───────────────────────────────────── -->
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
    </section>
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

.panel {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 14px 16px 16px;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.badge {
  font-size: 12px;
  color: #94a3b8;
}

.field {
  display: block;
  min-width: 0;
  margin-bottom: 10px;
}
.field > span,
.field > summary {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #94a3b8;
}
.field > summary {
  cursor: pointer;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 拼接预览：单行截断，悬停看全 */
.joined {
  margin: -2px 0 10px;
  padding: 6px 8px;
  border-left: 2px solid #334155;
  border-radius: 4px;
  background: #0b1220;
  font-size: 12px;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* 弹性子项默认 min-width:auto —— 数字输入框的固有宽度会把这一行撑破 */
.row > * {
  min-width: 0;
}
.times {
  color: #64748b;
}
.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}
.inline input[type='checkbox'] {
  width: auto;
  margin: 0;
}
.tiny {
  width: 56px;
}
.range {
  padding: 0;
  margin-top: 6px;
}

/* minmax(0,1fr)：直接用 1fr 时轨道下限是 auto，仍会被最长选项顶开 */
.grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
}
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}
.grid2 > *,
.grid3 > * {
  min-width: 0;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.presets button {
  font-size: 12px;
  padding: 3px 8px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.actions .primary {
  background: #0369a1;
  border-color: #0284c7;
  padding: 8px 18px;
}
.actions .primary:hover:not(:disabled) {
  background: #075985;
}
.jobid {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #64748b;
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
</style>
