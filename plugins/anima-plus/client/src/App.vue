<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import type { HealthResponse } from '@comfyui-web/shared';
import { api } from '@/api';
import WorkflowForm from '@/components/WorkflowForm.vue';
import DependencyNotice from '@/components/DependencyNotice.vue';
import HelpPanel from '@/components/HelpPanel.vue';
import PageHeader from '@/components/PageHeader.vue';
import SessionCard from '@/components/SessionCard.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';
import SubmitActions from '@/components/SubmitActions.vue';
import ViewSwitch from '@/components/ViewSwitch.vue';
import { useDependencies } from '@/composables/useDependencies';
import { useWorkflow } from '@/composables/useWorkflow';
import { useJobs } from '@/composables/useJobs';

const health = ref<HealthResponse | null>(null);

/** 帮助面板（显式展示包内 readme.md） */
const helpOpen = ref(false);
/** 设置面板：本插件的设置由自己持有（目录型 tab 的宿主设置页对它只读，见 components/SettingsPanel.vue） */
const settingsOpen = ref(false);
/**
 * 竖屏下「参数 / 队列」一次只显示一屏，切换条是 components/ViewSwitch.vue。
 * 宽屏两张卡并排，这个值不影响布局（class 挂上去也没有规则命中）。
 */
const view = ref<'param' | 'queue'>('param');
const log = ref<string[]>([]);

function pushLog(line: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  log.value.unshift(`[${t}] ${line}`);
  if (log.value.length > 200) log.value.pop();
}

// 三段状态各自成组：依赖 / 工作流与表单 / 作业与历史。同名解构 → 模板一个字都不用改。
const { deps, depsChecking, currentDeps, depsReady, showDepsProblem, checkDeps } =
  useDependencies(pushLog);
const { workflow, values, models, stateNote, fatalError, fail, loadWorkflow, saveLastState } =
  useWorkflow(pushLog);
const {
  status,
  submitting,
  savingState,
  queue,
  queueCount,
  recentAssets,
  recentJobId,
  errorMessage,
  history,
  clearing,
  assetThumbUrl,
  submit,
  saveState,
  cancel,
  reuse,
  clearHistory,
  refreshHistory,
  start,
  stop,
} = useJobs(pushLog, workflow, values, saveLastState);

// 队列在跑**不锁**表单：提交一回来就能改参数接着排下一条（这是这个插件排队能力的关键）
const canSubmit = computed(() => !!workflow.value && !submitting.value && depsReady.value);
// 存快照不看依赖：它只写自己空间里的 JSON，ComfyUI 缺节点时照样该能用（跨插件基底不该被出图环境卡住）
const canSaveState = computed(() => !!workflow.value && !savingState.value);

/**
 * 加入队列后切到队列屏：竖屏下提交完还停在参数屏，看着就像"点了没反应"。
 * 失败也切（错误信息和状态都在队列屏上，停在这里反而看不到）。
 */
async function submitAndShowQueue(): Promise<void> {
  try {
    await submit();
  } finally {
    view.value = 'queue';
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
    // 一个插件只有一份工作流定义，不需要先"列模板再挑一个"
    await loadWorkflow();
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
  syncStream();
});

/**
 * 任务事件流的去留：**可见就开着；不可见时只有还有在途任务才留着**。
 *
 * 开了常驻（设置页的「切走不卸载」，D26）之后 `onUnmounted` 不再随切 tab 触发，
 * 光靠它管这条连接就会攒下一堆没人读的连接 —— 所以改成"可见性 + 队列"两条判据：
 * 切走时还在跑的就留着（切回来即见进度，不用等重连），队列空了立刻断；
 * 切回来马上重连（连接即发在途快照，断线期间跑完的任务靠 onOpen 对账补上）。
 */
const visible = ref(true);

function syncStream(): void {
  if (visible.value || queueCount.value > 0) start();
  else stop();
}

onActivated(() => {
  visible.value = true;
  syncStream();
});

onDeactivated(() => {
  visible.value = false;
  syncStream();
});

// 切走时队列非空、之后又跑完了：这时连接已经没人看，补一次收尾
watch(queueCount, syncStream);

onUnmounted(() => {
  // tab 真的卸载了（没开常驻时"切走"就等于卸载）必须断流，否则反复切 tab 会攒下一堆没人读的连接
  stop();
});
</script>


<template>
  <div class="page">
    <PageHeader :health="health" @help="helpOpen = true" @settings="settingsOpen = true" />

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

    <!-- 竖屏切换条：只在 ≤900px 出现（宽屏两张卡并排，不用切） -->
    <ViewSwitch v-model:view="view" :queue-count="queueCount" />

    <main class="layout" :class="'view-' + view">
      <section class="card pane-param">
        <div class="card-head">
          <h2>参数</h2>
          <!-- 快照状态：让人看得见"刷新不会归零"这件事真的生效了（值来自 last-state.json） -->
          <span v-if="stateNote" class="dim small">{{ stateNote }}</span>
        </div>

        <WorkflowForm
          v-if="workflow"
          :inputs="workflow.inputs"
          :values="values"
          :models="models"
        />

        <!-- 竖屏专用：切到「参数」屏时队列卡是隐藏的，出口不能跟着藏（宽屏这一份 display:none） -->
        <SubmitActions
          class="in-param"
          :submitting="submitting"
          :saving-state="savingState"
          :can-submit="canSubmit"
          :can-save-state="canSaveState"
          :deps-ready="depsReady"
          :missing="currentDeps?.missing ?? []"
          @submit="submitAndShowQueue"
          @save="saveState"
        />
      </section>

      <section class="card pane-queue">
        <div class="card-head">
          <h2>队列</h2>
          <span v-if="queueCount" class="dim small">在途 {{ queueCount }} 个</span>
        </div>

        <!-- 开始生成放在队列卡顶部：点了就在同一张卡里看进度，不用在两张卡之间来回找 -->
        <SubmitActions
          :submitting="submitting"
          :saving-state="savingState"
          :can-submit="canSubmit"
          :can-save-state="canSaveState"
          :deps-ready="depsReady"
          :missing="currentDeps?.missing ?? []"
          @submit="submitAndShowQueue"
          @save="saveState"
        />

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
            <!-- 进度条是**整条工作流**的总进度（服务端算的 overall），不是当前节点那一段 -->
            <div class="status-line small">
              <span v-if="row.progress">总进度 {{ row.percent }}%</span>
              <span v-else>等上游调度…</span>
              <span v-if="row.progress?.label" class="dim">{{ row.progress.label }}</span>
              <span v-if="row.progress?.max" class="dim">
                {{ row.progress.value }} / {{ row.progress.max }} 步
              </span>
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

      <!-- 本次会话：跟着队列屏走（竖屏切到「参数」时它一起收起来，不在参数下面孤零零挂着） -->
      <SessionCard
        class="pane-queue"
        :history="history"
        :clearing="clearing"
        :thumb-url="assetThumbUrl"
        @clear="clearHistory"
        @reuse="reuse"
      />
    </main>
  </div>
</template>

<style scoped src="./ui.css"></style>
<style scoped src="./App.css"></style>
<style scoped src="./App.controls.css"></style>
