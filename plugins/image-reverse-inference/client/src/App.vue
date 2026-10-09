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
        <small>上传前自动转 webp：目标 {{ formatBytes(TARGET_BYTES) }}，上限 {{ formatBytes(MAX_BYTES) }}</small>
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
      <span v-if="note" class="iri-meta">{{ note }}</span>
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

import { api, type ModelResponse, type StatusResponse } from './api';
import { MAX_BYTES, TARGET_BYTES, formatBytes, prepareImage, type PreparedImage } from './compress';
import { DEFAULT_PARAMS, toParams } from './params';
import SettingsPanel from './components/SettingsPanel.vue';
import type { TaggerParams } from './types';

const fileInput = ref<HTMLInputElement | null>(null);
const prepared = ref<PreparedImage | null>(null);
const preview = ref('');
const imageInfo = ref('');
const busy = ref(false);
const error = ref('');
const tags = ref('');
const copied = ref(false);
const elapsed = ref(0);
/** 「参数写回默认值」的结果，只在 actions 行说一句 */
const note = ref('');
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
    const result = await prepareImage(file);
    prepared.value = result;
    preview.value = result.dataUrl;
    const scaled = result.width !== 0 && result.rounds > 0 ? `，缩放 ${result.rounds} 轮` : '';
    imageInfo.value =
      `${result.filename} · ${result.width}×${result.height} · ` +
      `${formatBytes(result.originalBytes)} → ${formatBytes(result.bytes)}${scaled}`;
  } catch (err) {
    prepared.value = null;
    preview.value = '';
    imageInfo.value = '';
    error.value = err instanceof Error ? err.message : String(err);
  }
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

async function run(): Promise<void> {
  const image = prepared.value;
  if (image === null || busy.value) return;
  busy.value = true;
  error.value = '';
  copied.value = false;
  note.value = '';
  // 与反推**并行**：把参数写回默认值不该拖慢出结果（失败也不影响这次反推）
  const saving = persistParams();
  try {
    const result = await api.infer({
      dataUrl: image.dataUrl,
      filename: image.filename,
      params: params.value,
    });
    tags.value = result.tags;
    elapsed.value = result.elapsedMs;
    status.value = await api.status().catch(() => status.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
  await saving;
}

/** 参数行的持久化时机 = 点「开始反推」（值本来就随这次请求送过去，落盘只为下次打开） */
async function persistParams(): Promise<void> {
  try {
    await api.saveParams({ ...params.value });
    note.value = '参数已存为默认';
  } catch (err) {
    note.value = `参数没存下来：${err instanceof Error ? err.message : String(err)}`;
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
