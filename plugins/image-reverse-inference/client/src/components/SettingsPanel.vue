<template>
  <section class="iri-settings">
    <div class="iri-settings-head">
      <h2>设置</h2>
      <span class="iri-meta">{{ file }}</span>
    </div>

    <div class="iri-params">
      <label class="iri-field iri-field--wide">
        <span>ComfyUI 地址</span>
        <input v-model="form.comfyuiBaseUrl" class="iri-input" placeholder="http://10.0.0.5:8188" />
      </label>
      <label class="iri-field iri-field--range">
        <span>一般标签阈值 <b class="iri-num">{{ form.threshold.toFixed(2) }}</b></span>
        <input
          v-model.number="form.threshold"
          type="range"
          min="0"
          max="1"
          step="0.05"
          class="iri-range"
        />
      </label>
      <label class="iri-field iri-field--range">
        <span>角色阈值 <b class="iri-num">{{ form.characterThreshold.toFixed(2) }}</b></span>
        <input
          v-model.number="form.characterThreshold"
          type="range"
          min="0"
          max="1"
          step="0.05"
          class="iri-range"
        />
      </label>
      <label class="iri-check">
        <input v-model="form.replaceUnderscore" type="checkbox" />
        <span>下划线换空格</span>
      </label>
      <label class="iri-check">
        <input v-model="form.trailingComma" type="checkbox" />
        <span>末尾加逗号</span>
      </label>
      <label class="iri-field iri-field--wide">
        <span>排除标签</span>
        <input v-model="form.excludeTags" class="iri-input" />
      </label>
    </div>

    <div class="iri-actions">
      <button class="iri-btn iri-btn--primary" type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存并重挂' }}
      </button>
      <span v-if="message" class="iri-meta">{{ message }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api, reloadPlugin } from '../api';
import { DEFAULT_PARAMS, readString, toParams } from '../params';
import type { TaggerParams } from '../types';

const emit = defineEmits<{ saved: [] }>();

const file = ref('');
const saving = ref(false);
const message = ref('');
const form = ref<TaggerParams & { comfyuiBaseUrl: string }>({
  comfyuiBaseUrl: '',
  ...DEFAULT_PARAMS,
});

onMounted(async () => {
  const response = await api.settings();
  file.value = response.file;
  const values = response.effective;
  form.value = { comfyuiBaseUrl: readString(values.comfyuiBaseUrl, ''), ...toParams(values) };
});

async function save(): Promise<void> {
  saving.value = true;
  message.value = '';
  try {
    await api.saveSettings({ ...form.value });
    // 值落盘 ≠ 生效：重挂后 server/index.ts 才会用新地址建 ComfyClient（D20）
    await reloadPlugin();
    message.value = '已保存，插件已重挂';
    emit('saved');
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>
