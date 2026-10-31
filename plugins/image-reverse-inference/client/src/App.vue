<template>
  <div class="iri">
    <header class="iri-head">
      <div>
        <h1 class="iri-title">图片反推</h1>
        <p class="iri-sub">WD14 Tagger：图 → tags 文本</p>
      </div>
      <div class="iri-head-right">
        <span class="iri-dot" :class="dotClass" :title="statusText"></span>
        <span class="iri-status">{{ statusText }}</span>
        <button class="iri-btn" type="button" @click="showSettings = !showSettings">
          {{ showSettings ? '收起设置' : '设置' }}
        </button>
      </div>
    </header>

    <SettingsPanel v-if="showSettings" @saved="onSettingsSaved" />

    <section
      class="iri-drop"
      :class="{ 'is-busy': busy }"
      @click="pick"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <input ref="fileInput" type="file" accept="image/*" class="iri-file" @change="onPick" />
      <img v-if="preview" :src="preview" class="iri-preview" alt="待反推的图片" />
      <div v-else class="iri-hint">
        <strong>拖入图片</strong>
        <span>或点击选择文件</span>
        <small>
          上传前自动转 webp：目标 {{ formatBytes(TARGET_BYTES) }}，图片上限
          {{ formatBytes(maxImageBytes(bodyBudget)) }}（请求体 {{ formatBytes(bodyBudget) }}）
        </small>
      </div>
    </section>

    <p v-if="imageInfo" class="iri-meta">{{ imageInfo }}</p>
    <p v-if="error" class="iri-error">{{ error }}</p>

    <section class="iri-params">
      <span class="iri-field iri-field--model">
        <span>模型</span>
        <b class="iri-model">{{ model.model || '工作流未指定' }}</b>
        <small v-if="model.installed === false" class="iri-warn">本机 ComfyUI 没装这个模型</small>
        <small v-else class="iri-meta">来自 workflow.json，换模型请重新导出工作流</small>
      </span>
      <label class="iri-field iri-field--range">
        <span>一般标签阈值 <b class="iri-num">{{ params.threshold.toFixed(2) }}</b></span>
        <input
          v-model.number="params.threshold"
          type="range"
          min="0"
          max="1"
          step="0.05"
          class="iri-range"
        />
      </label>
      <label class="iri-field iri-field--range">
        <span>角色阈值 <b class="iri-num">{{ params.characterThreshold.toFixed(2) }}</b></span>
        <input
          v-model.number="params.characterThreshold"
          type="range"
          min="0"
          max="1"
          step="0.05"
          class="iri-range"
        />
      </label>
      <label class="iri-check">
        <input v-model="params.replaceUnderscore" type="checkbox" />
        <span>下划线换空格</span>
      </label>
      <label class="iri-check">
        <input v-model="params.trailingComma" type="checkbox" />
        <span>末尾加逗号</span>
      </label>
      <label class="iri-field iri-field--wide">
        <span>排除标签</span>
        <input v-model="params.excludeTags" class="iri-input" placeholder="逗号分隔，可留空" />
      </label>
    </section>

    <div class="iri-actions">
      <button class="iri-btn iri-btn--primary" type="button" :disabled="busy || prepared === null" @click="run">
        {{ busy ? '反推中…' : '开始反推' }}
      </button>
      <span v-if="elapsed" class="iri-meta">上次耗时 {{ elapsed }} ms</span>
    </div>

    <section class="iri-result">
      <div class="iri-result-head">
        <span>反推结果</span>
        <button class="iri-btn" type="button" :disabled="tags === ''" @click="copy">
          {{ copied ? '已复制' : '复制' }}
        </button>
      </div>
      <textarea
        v-model="tags"
        class="iri-textarea"
        rows="6"
        placeholder="反推出来的 tags 会出现在这里，可以直接改"
      ></textarea>
      <p class="iri-meta">{{ tags.length }} 字符</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { ApiError, api, type ModelResponse, type StatusResponse } from './api';
import {
  MAX_BODY_BYTES,
  TARGET_BYTES,
  formatBytes,
  maxImageBytes,
  prepareImage,
  type PreparedImage,
} from './compress';
import { DEFAULT_PARAMS, toParams } from './params';
import SettingsPanel from './components/SettingsPanel.vue';
import type { TaggerParams } from './types';

const fileInput = ref<HTMLInputElement | null>(null);
const prepared = ref<PreparedImage | null>(null);
/** 原图先留着：撞到 413 要按更小的预算重新等比缩一遍 */
const sourceFile = ref<File | null>(null);
/**
 * 本次会话里**实测**的请求体上限。
 *
 * 默认是宿主 fastify 的 4 MiB；前面那层代理（nginx 默认 `client_max_body_size 1m`）
 * 比它严时只有发出去才知道 —— 撞 413 就减半，之后都按新值压。
 */
const bodyBudget = ref(MAX_BODY_BYTES);
const preview = ref('');
const imageInfo = ref('');
const busy = ref(false);
const error = ref('');
const tags = ref('');
const copied = ref(false);
const elapsed = ref(0);
const showSettings = ref(false);
const status = ref<StatusResponse | null>(null);

const params = ref<TaggerParams>({ ...DEFAULT_PARAMS });
/** 模型是工作流的事实，这里只是显示它、并提示本机装没装 */
const model = ref<ModelResponse>({ reachable: false, model: '', installed: null });

const dotClass = computed(() => {
  const comfyui = status.value?.comfyui;
  if (comfyui === undefined) return 'iri-dot--idle';
  return comfyui.reachable ? 'iri-dot--ok' : 'iri-dot--bad';
});
const statusText = computed(() => {
  const comfyui = status.value?.comfyui;
  if (comfyui === undefined) return '状态未知';
  if (!comfyui.reachable) return `连不上 ComfyUI：${comfyui.error}`;
  return `ComfyUI ${comfyui.version ?? '?'} · ${comfyui.device ?? ''}`.trim();
});

function applyDefaults(defaults: TaggerParams): void {
  params.value = { ...defaults };
}

async function refresh(): Promise<void> {
  const [modelRes, stat, conf] = await Promise.all([api.model(), api.status(), api.settings()]);
  model.value = modelRes;
  status.value = stat;
  applyDefaults(toParams(conf.effective));
}

async function onSettingsSaved(): Promise<void> {
  showSettings.value = false;
  await refresh().catch((err: unknown) => {
    error.value = err instanceof Error ? err.message : String(err);
  });
}

function pick(): void {
  if (!busy.value) fileInput.value?.click();
}

async function accept(file: File | undefined): Promise<void> {
  if (file === undefined) return;
  error.value = '';
  tags.value = '';
  try {
    showPrepared(await prepareImage(file, bodyBudget.value));
    sourceFile.value = file;
  } catch (err) {
    reset();
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function showPrepared(result: PreparedImage): void {
  prepared.value = result;
  preview.value = result.dataUrl;
  const scaled = result.rounds > 0 ? `，等比缩 ${result.rounds} 轮` : '';
  imageInfo.value =
    `${result.filename} · ${result.width}×${result.height} · ` +
    `${formatBytes(result.originalBytes)} → ${formatBytes(result.bytes)}` +
    `（请求体 ${formatBytes(result.bodyBytes)}）${scaled}`;
}

function reset(): void {
  prepared.value = null;
  sourceFile.value = null;
  preview.value = '';
  imageInfo.value = '';
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  void accept(input.files?.[0]);
  input.value = '';
}

function onDrop(event: DragEvent): void {
  if (busy.value) return;
  void accept(event.dataTransfer?.files?.[0]);
}

/** 413 之后最多缩几档：4 MiB → 2 → 1 → 512 KiB，nginx 默认 1m 两档就够 */
const MAX_RETRY_ON_413 = 3;
/** 再小就没有反推的意义了，撞到这个数还 413 就认了 */
const MIN_BODY_BUDGET = 128 * 1024;

async function run(): Promise<void> {
  if (prepared.value === null || busy.value) return;
  busy.value = true;
  error.value = '';
  copied.value = false;
  try {
    let image = prepared.value;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await api.infer({
          dataUrl: image.dataUrl,
          filename: image.filename,
          params: params.value,
        });
        tags.value = result.tags;
        elapsed.value = result.elapsedMs;
        status.value = await api.status().catch(() => status.value);
        break;
      } catch (err) {
        // 413 说明真实请求体上限比我们假设的小（前面挂的代理比宿主严）：
        // 预算减半、按新预算等比缩完再发，而不是把「Payload Too Large」甩给用户
        const canRetry =
          err instanceof ApiError &&
          err.status === 413 &&
          attempt < MAX_RETRY_ON_413 &&
          sourceFile.value !== null &&
          bodyBudget.value > MIN_BODY_BUDGET;
        if (!canRetry || sourceFile.value === null) throw err;
        bodyBudget.value = Math.max(MIN_BODY_BUDGET, Math.floor(bodyBudget.value / 2));
        image = await prepareImage(sourceFile.value, bodyBudget.value);
        showPrepared(image);
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(tags.value);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    error.value = '复制失败（浏览器不给剪贴板权限），请手动选中复制';
  }
}

onMounted(() => {
  void refresh().catch((err: unknown) => {
    error.value = err instanceof Error ? err.message : String(err);
  });
});
</script>
