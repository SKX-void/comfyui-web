<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DepsReport, HealthResponse, Job, JobProgress, TemplateDetail } from '@comfyui-web/shared';
import { api, apiUrl, assetUrl, subscribeJob } from '@/api';
import { defaultValues, normalizeValues, type FieldModel } from '@/form';
import TemplateForm from '@/components/TemplateForm.vue';
import DependencyNotice from '@/components/DependencyNotice.vue';
import HelpPanel from '@/components/HelpPanel.vue';

const health = ref<HealthResponse | null>(null);
/** 依赖检查结果；null = 还没查过 */
const deps = ref<DepsReport | null>(null);
const depsChecking = ref(false);
/** 依赖面板手工展开（正常时它不出现，只在顶栏留一个 pill） */
const depsOpen = ref(false);
/** 帮助面板（显式展示包内 readme.md） */
const helpOpen = ref(false);
const templates = ref<Array<{ id: string; name: string }>>([]);
const template = ref<TemplateDetail | null>(null);
const values = ref<FieldModel>({});
const models = ref<Record<string, string[]>>({});

const submitting = ref(false);
const activeJobId = ref<string | null>(null);
const status = ref<string>('空闲');
const progress = ref<JobProgress | null>(null);
const assets = ref<Array<{ assetId: string; url: string; filename: string }>>([]);
const errorMessage = ref<string | null>(null);
/** 初始化阶段的致命错误（页面会显示横幅，而不是静默残缺） */
const fatalError = ref<string | null>(null);
const history = ref<Job[]>([]);
const clearing = ref(false);
const log = ref<string[]>([]);

let unsubscribe: (() => void) | null = null;

/** 当前模板的依赖结论；查不了时为 null */
const currentDeps = computed(
  () => deps.value?.templates.find((t) => t.id === template.value?.id) ?? null,
);
/** 只在**确实缺**的时候拦提交；"没查成"不拦 */
const depsReady = computed(() => currentDeps.value?.ready ?? true);
const canSubmit = computed(() => !!template.value && !submitting.value && depsReady.value);

/** 顶栏 pill 的形态：ok / 缺 N / ？（没查成）/ 检查中 */
const depsState = computed(() => {
  if (deps.value === null) return depsChecking.value ? '' : 'warn';
  if (deps.value.ok === null) return 'warn';
  return (currentDeps.value?.missing.length ?? 0) > 0 ? 'bad' : 'ok';
});
const depsPillText = computed(() => {
  if (deps.value === null) return depsChecking.value ? '检查中…' : '?';
  if (deps.value.ok === null) return '?';
  const missing = currentDeps.value?.missing.length ?? 0;
  return missing > 0 ? `缺 ${missing}` : '✓';
});
/** 有真问题（缺节点 / 没查成）时提示条自己冒出来 */
const showDepsProblem = computed(
  () =>
    deps.value !== null &&
    (deps.value.ok === null || (currentDeps.value?.missing.length ?? 0) > 0),
);

function pushLog(line: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  log.value.unshift(`[${t}] ${line}`);
  if (log.value.length > 200) log.value.pop();
}

/**
 * 查依赖：模板声明的节点类，这台 ComfyUI 到底有没有。
 *
 * 失败**不影响任何操作**：记成 ok:null（"没查成"）而不是"缺依赖" ——
 * 把连不上当成缺依赖，会把用户引去装一堆本来就在的包。
 */
async function checkDeps(refresh = false): Promise<void> {
  depsChecking.value = true;
  try {
    deps.value = await api.deps(refresh);
    const missing = currentDeps.value?.missing ?? [];
    if (missing.length > 0) {
      pushLog(`依赖：当前模板缺 ${missing.length} 个节点 —— ${missing.join('、')}`);
    } else if (deps.value.ok === null) {
      pushLog(`依赖检查未完成（ComfyUI 不可达）：${deps.value.error ?? ''}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.value = {
      ok: null,
      checkedAt: null,
      error: message,
      missingBuiltin: [],
      missing: [],
      packs: [],
      templates: [],
    };
    pushLog(`依赖检查失败: ${message}`);
  } finally {
    depsChecking.value = false;
  }
}

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
    const list = await api.listTemplates();
    templates.value = list.items;
    if (list.items[0]) {
      await loadTemplate(list.items[0].id);
    }
  } catch (err) {
    // 关键：模板加载失败必须**可见**，否则页面会静默残缺
    // （曾经因为 structuredClone 缺失抛错，只剩描述、没有表单、无人知道为什么）
    fail(`模板加载失败: ${(err as Error).message}`);
  }

  await refreshHistory();
}

/** 把一个致命错误同时写进日志与页面横幅 */
function fail(message: string): void {
  fatalError.value = message;
  pushLog(`✘ ${message}`);
}

async function loadTemplate(id: string): Promise<void> {
  fatalError.value = null;
  const tpl = await api.getTemplate(id);
  template.value = tpl;
  // 先算好表单值再声明成功：否则会留下"模板已设但表单为空"的半截状态
  values.value = defaultValues(tpl.inputs);
  pushLog(
    `模板已加载: ${tpl.name}（${tpl.graphNodeCount} 个节点 / ${tpl.inputs?.length ?? 0} 个输入）`,
  );

  // 预取 model-select 需要的模型列表
  const folders = new Set(
    (tpl.inputs ?? [])
      .filter((i) => i.type === 'model-select' && i.source?.folder)
      .map((i) => i.source!.folder!),
  );
  for (const folder of folders) {
    try {
      const res = await api.listModels(folder);
      models.value[folder] = res.items;
      pushLog(`模型目录 ${folder}: ${res.items.length} 项`);
    } catch (err) {
      models.value[folder] = [];
      pushLog(`模型目录 ${folder} 读取失败: ${(err as Error).message}`);
    }
  }
}

async function refreshHistory(): Promise<void> {
  try {
    history.value = (await api.listJobs()).items.slice(0, 8);
  } catch {
    /* 忽略 */
  }
}

/** 清空历史记录：服务端只清已结束的任务，在途的会保留 */
async function clearHistory(): Promise<void> {
  clearing.value = true;
  try {
    const res = await api.clearJobs();
    history.value = res.items.slice(0, 8);
    const parts = [`已清空 ${res.cleared} 条历史`];
    if (res.kept > 0) parts.push(`${res.kept} 个任务还在跑，已保留`);
    status.value = parts.join('，');
    pushLog(parts.join('，'));
  } catch (e) {
    status.value = '清空失败';
    pushLog(`清空历史失败: ${(e as Error).message}`);
  } finally {
    clearing.value = false;
  }
}

async function submit(): Promise<void> {
  if (!template.value) return;
  submitting.value = true;
  errorMessage.value = null;
  assets.value = [];
  progress.value = null;
  status.value = '提交中…';

  try {
    const res = await api.createJob({
      templateId: template.value.id,
      values: normalizeValues(template.value.inputs, values.value),
    });
    activeJobId.value = res.jobId;
    pushLog(`任务已创建 ${res.jobId} · promptId=${res.promptId ?? '-'}`);

    unsubscribe?.();
    unsubscribe = subscribeJob(res.jobId, (evt) => {
      switch (evt.type) {
        case 'snapshot':
          status.value = String(evt.data.status ?? '');
          if (evt.data.progress) progress.value = evt.data.progress as JobProgress;
          break;
        case 'queued':
          status.value = '排队中';
          break;
        case 'started':
          status.value = '执行中';
          break;
        case 'progress': {
          const p = evt.data as unknown as JobProgress;
          progress.value = { value: p.value, max: p.max, node: p.node ?? null };
          status.value = '执行中';
          break;
        }
        case 'node':
          pushLog(`执行节点 ${String(evt.data.node)}`);
          break;
        case 'completed': {
          status.value = '已完成';
          // SSE 是绕开 api 层的第二条数据入口，产出图 URL 同样要改写到反代前缀下
          const raw =
            (evt.data.assets as Array<{ assetId: string; url: string; filename: string }>) ?? [];
          assets.value = raw.map((a) => ({ ...a, url: assetUrl(a.url) }));
          pushLog(`完成 · 产出 ${assets.value.length} 张`);
          submitting.value = false;
          cleanup();
          void refreshHistory();
          break;
        }
        case 'error': {
          status.value = '失败';
          errorMessage.value = String(evt.data.message ?? '执行失败');
          pushLog(`错误: ${errorMessage.value}`);
          submitting.value = false;
          cleanup();
          void refreshHistory();
          break;
        }
        case 'canceled':
          status.value = '已取消';
          submitting.value = false;
          cleanup();
          break;
      }
    });
  } catch (err) {
    const e = err as Error & { details?: unknown };
    errorMessage.value = e.message;
    status.value = '提交失败';
    submitting.value = false;
    pushLog(`提交失败: ${e.message}`);
    if (e.details) pushLog(`详情: ${JSON.stringify(e.details)}`);
  }
}

function cleanup(): void {
  unsubscribe?.();
  unsubscribe = null;
}

async function cancel(): Promise<void> {
  if (!activeJobId.value) return;
  try {
    await api.cancelJob(activeJobId.value);
    pushLog('已请求取消');
  } catch (err) {
    pushLog(`取消失败: ${(err as Error).message}`);
  }
}

function reuse(job: Job): void {
  values.value = { ...values.value, ...job.values };
  pushLog(`已复用任务 ${job.jobId} 的参数`);
}

const percent = computed(() => {
  const p = progress.value;
  if (!p || !p.max) return 0;
  return Math.min(100, Math.round((p.value / p.max) * 100));
});

/**
 * 任务列表里的小图走缩略图端点。
 * 产出图可能是 1~2MB，用来渲染 56px 的缩略图纯属浪费网络。
 */
function assetThumbUrl(assetId: string): string {
  return apiUrl(`/api/assets/${encodeURIComponent(assetId)}/thumb?w=112&h=112`);
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
});
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>ComfyUI 轻前端</h1>
      <div class="health" v-if="health">
        <span class="pill" :class="health.comfyMode">模式 {{ health.comfyMode }}</span>
        <span class="pill" :class="health.comfyui.reachable ? 'ok' : 'bad'">
          ComfyUI {{ health.comfyui.reachable ? '可达' : '不可达' }}
        </span>
        <span class="pill" :class="health.ws.connected ? 'ok' : 'bad'">
          WS {{ health.ws.connected ? '已连接' : '未连接' }}
        </span>
        <span class="pill" :class="health.weilin.available ? 'ok' : 'bad'">
          WeiLin {{ health.weilin.available ? `就绪 · ${health.weilin.total} LoRA` : '不可用' }}
        </span>
        <span
          class="pill clickable"
          :class="depsState"
          role="button"
          tabindex="0"
          title="点击查看依赖清单（每个节点包 + 安装地址）"
          @click="depsOpen = !depsOpen"
        >
          依赖 {{ depsPillText }}
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
    </header>

    <div v-if="fatalError" class="banner">
      <strong>页面初始化失败</strong>
      <p>{{ fatalError }}</p>
      <p class="banner-hint">
        打开「运行日志」查看详情；也可尝试刷新页面。若持续失败，请确认后端与模板配置。
      </p>
    </div>

    <DependencyNotice
      v-if="depsOpen || showDepsProblem"
      :deps="deps"
      :template-id="template?.id ?? null"
      :checking="depsChecking"
      @refresh="checkDeps(true)"
      @close="depsOpen = false"
    />

    <HelpPanel v-if="helpOpen" :deps="deps" @close="helpOpen = false" />

    <main class="layout">
      <section class="card">
        <div class="card-head">
          <h2>参数</h2>
          <select
            v-if="templates.length > 1"
            class="control"
            :value="template?.id"
            @change="loadTemplate(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>

        <TemplateForm
          v-if="template"
          :inputs="template.inputs"
          :values="values"
          :models="models"
          :disabled="submitting"
        />

        <div class="actions">
          <button class="btn primary" :disabled="!canSubmit" @click="submit">
            {{ submitting ? '生成中…' : '开始生成' }}
          </button>
          <button class="btn" :disabled="!submitting" @click="cancel">取消</button>
          <span v-if="!depsReady" class="actions-hint bad">
            缺节点 {{ currentDeps?.missing.join('、') }} —— 装好并重启 ComfyUI 后即可生成
          </span>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>进度</h2></div>

        <div class="status-line">
          <strong>状态：</strong><span>{{ status }}</span>
        </div>

        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: percent + '%' }" />
        </div>
        <div class="status-line small">
          <span v-if="progress">{{ progress.value }} / {{ progress.max }} 步</span>
          <span v-else>—</span>
          <span v-if="progress?.node" class="dim">节点 {{ progress.node }}</span>
        </div>

        <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

        <div v-if="assets.length" class="results">
          <img
            v-for="a in assets"
            :key="a.assetId"
            :src="a.url"
            :alt="a.filename"
            class="result-img"
          />
        </div>

        <details class="logbox">
          <summary>运行日志（{{ log.length }}）</summary>
          <pre>{{ log.join('\n') }}</pre>
        </details>
      </section>

      <section class="card wide">
        <div class="card-head">
          <h2>本次会话</h2>
          <div class="head-right">
            <span class="dim small">不持久化 · 后端重启即清空</span>
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
              <th>任务</th><th>状态</th><th>产出</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in history" :key="job.jobId">
              <td class="mono" data-label="任务">{{ job.jobId.slice(0, 12) }}…</td>
              <td data-label="状态"><span class="pill" :class="job.status">{{ job.status }}</span></td>
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
          本次会话还没有任务。出图参数不会长期保存 —— 需要留档时把「输出格式」切到
          <strong>PNG</strong>，完整工作流会写进图片元数据。
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page {
  max-width: 1400px;
  margin: 0 auto;
  /* 同上：边距由宿主外壳提供，这里不重复叠加 */
  padding: 0;
}
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
h2 {
  font-size: 14px;
  margin: 0;
  color: #cbd5e1;
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
/* 依赖 pill：可点开清单；warn = 没查成（区别于"确实缺"） */
.pill.clickable {
  cursor: pointer;
  user-select: none;
}
.pill.warn {
  color: #fcd34d;
  border-color: #78350f;
}
.actions-hint {
  font-size: 12px;
  align-self: center;
  min-width: 0;
}
.actions-hint.bad {
  color: #f87171;
}
.banner {
  background: #3f1d1d;
  border: 1px solid #7f1d1d;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
}
.banner strong {
  color: #fca5a5;
  font-size: 13px;
}
.banner p {
  margin: 6px 0 0;
  font-size: 12px;
  color: #fecaca;
  word-break: break-all;
}
.banner-hint {
  color: #f0a5a5 !important;
  opacity: 0.85;
}
.pill {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  background: #1e293b;
  border: 1px solid #334155;
  color: #94a3b8;
}
.pill.ok,
.pill.succeeded {
  color: #6ee7b7;
  border-color: #065f46;
}
.pill.bad,
.pill.failed {
  color: #fca5a5;
  border-color: #7f1d1d;
}
.pill.running,
.pill.mock {
  color: #93c5fd;
  border-color: #1e40af;
}
.pill.real {
  color: #fcd34d;
  border-color: #78350f;
}
.layout {
  display: grid;
  /* 0 下限而不是 320/360px：固定下限会在窄屏上把网格轨道撑得比视口还宽，
     整页随即出现横向滚动条。列宽交给 1fr 平分，装不下时由内容自己换行。 */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.card {
  background: #111827;
  border: 1px solid #1f2937;
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 网格项默认 min-width:auto = 内容最小宽度，会被里面的宽表格反向撑爆轨道 */
  min-width: 0;
}
.card.wide {
  grid-column: 1 / -1;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
/* 右半边：说明文字 + 操作按钮（窄屏时允许换行，别把标题挤走） */
.head-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.desc {
  font-size: 12px;
  color: #64748b;
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.btn {
  border-radius: 6px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}
.btn.primary {
  background: #4f46e5;
  border-color: #4f46e5;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.control {
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 7px 10px;
  font-size: 13px;
}
.status-line {
  font-size: 13px;
  color: #cbd5e1;
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-line.small {
  font-size: 12px;
  color: #94a3b8;
}
.dim {
  color: #64748b;
}
.dim.small {
  font-size: 11px;
}
.progress-bar {
  height: 10px;
  background: #0f172a;
  border: 1px solid #1f2937;
  border-radius: 999px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4f46e5, #06b6d4);
  transition: width 0.2s ease;
}
.error {
  color: #fca5a5;
  font-size: 13px;
  margin: 0;
  white-space: pre-wrap;
}
/* 产出图：自适应缩放（宽度跟随容器，高度跟随视口），不再写死 520px */
.results {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-start;
}
.result-img {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 78vh;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid #1f2937;
}
/* 列表缩略图：随视口等比缩放 */
.thumb {
  width: clamp(44px, 10vw, 72px);
  height: clamp(44px, 10vw, 72px);
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #1f2937;
}
.thumb-link {
  margin-right: 6px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid #1f2937;
  vertical-align: middle;
}
.mono {
  font-family: ui-monospace, monospace;
}
.logbox summary {
  cursor: pointer;
  font-size: 12px;
  color: #94a3b8;
}
.logbox pre {
  max-height: 200px;
  overflow: auto;
  background: #0b1220;
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  color: #94a3b8;
  margin: 8px 0 0;
  white-space: pre-wrap;
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

/**
 * 窄屏（手机）：整页不再依赖横向滚动，需要横向排的东西一律改成竖向堆叠。
 *
 * 「本次会话」那张表格是主要元凶：任务号/状态/缩略图/按钮的最小内容宽度
 * 在 360px 屏上必然超过视口，表格不会自己换行，于是把整页撑宽。
 * 这里不复制一份 DOM（缩略图会请求两次），而是同一个表格换皮：
 * 隐藏表头，td 变块，字段名由 td[data-label] 用 ::before 生成 —— 每行就是一张卡片。
 */
@media (max-width: 640px) {
  .page {
    padding: 12px;
  }

  /* --- 历史记录：表格 → 卡片 --- */
  .table,
  .table tbody,
  .table tr,
  .table td {
    display: block;
    width: 100%;
  }
  .table thead {
    display: none;
  }
  .table tr {
    border: 1px solid #1f2937;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
  }
  .table tr:last-child {
    margin-bottom: 0;
  }
  .table td {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 8px;
    padding: 3px 0;
    border-bottom: none;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .table td::before {
    content: attr(data-label);
    flex: none;
    width: 3em;
    font-size: 11px;
    color: #64748b;
  }
  .table .mono {
    word-break: break-all;
  }
  /* 缩略图行：按中线对齐，去掉 flex gap 之外的多余右间距 */
  .table td.cell-assets {
    align-items: center;
  }
  .table td.cell-assets .thumb-link {
    margin-right: 0;
  }
  /* 操作行没有字段名，按钮靠右 */
  .table td.cell-action {
    justify-content: flex-end;
    padding-top: 8px;
  }
  .table td.cell-action::before {
    content: none;
  }
}
</style>
