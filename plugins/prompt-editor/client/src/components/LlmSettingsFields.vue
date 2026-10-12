<script setup lang="ts">
/**
 * 翻译面板里的「LLM 辅助」设置段（D27）：enabled 是 /llm/* 的总闸，key 只存后端。
 * 保存只发 `llm` 段 —— 服务端 PUT /settings 是浅合并，翻译段不会被覆盖。
 */
import { onMounted, ref } from 'vue';

import { fetchSettings, saveSettings, type LlmSettings } from '../api';

const draft = ref<LlmSettings>({
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: '',
  timeoutMs: 60000,
  maxCallsPerDay: 200,
  newBlockColor: '#6ea8fe',
  maxToolRounds: 12,
});
const usageLlmCalls = ref(0);
const busy = ref(false);
const error = ref('');
const hint = ref('');

onMounted(async () => {
  try {
    const payload = await fetchSettings();
    draft.value = payload.settings.llm;
    usageLlmCalls.value = payload.usage.llmCalls;
  } catch (err) {
    error.value = `读设置失败：${(err as Error).message}`;
  }
});

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  hint.value = '';
  try {
    await saveSettings({ llm: draft.value });
    hint.value = '已保存';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="pe-field">
    <label>
      <input v-model="draft.enabled" type="checkbox" />
      启用 LLM 辅助（总闸：关掉时 /llm/* 一律 403）
    </label>
    <p class="pe-note">
      协议只做 OpenAI-compatible 的非流式 chat + tool calling。baseUrl / apiKey 只存在插件后端，
      浏览器拿不到 key。
    </p>
  </div>

  <div class="pe-field pe-field-row">
    <label>baseUrl</label>
    <input v-model="draft.baseUrl" class="pe-input" type="text" placeholder="https://api.example.com/v1" />
    <label>模型</label>
    <input v-model="draft.model" class="pe-input" type="text" placeholder="模型名" />
  </div>

  <div class="pe-field pe-field-row">
    <label>apiKey</label>
    <input v-model="draft.apiKey" class="pe-input" type="password" placeholder="只存后端" autocomplete="off" />
    <label>AI 块颜色</label>
    <input v-model="draft.newBlockColor" class="pe-input" type="text" maxlength="32" />
  </div>

  <div class="pe-field pe-field-row">
    <label>超时（毫秒）</label>
    <input v-model.number="draft.timeoutMs" class="pe-input pe-input-num" type="number" min="1000" max="300000" />
    <label>每日上限</label>
    <input v-model.number="draft.maxCallsPerDay" class="pe-input pe-input-num" type="number" min="0" max="100000" />
    <label>工具轮数</label>
    <input v-model.number="draft.maxToolRounds" class="pe-input pe-input-num" type="number" min="1" max="100" />
    <p class="pe-note">
      一次「生成」提交算 1 次调用（内部多轮 tool call 不另计）；今天已用 {{ usageLlmCalls }} 次。
      0 = 禁用生成（配额耗尽）。
    </p>
  </div>

  <p v-if="error !== ''" class="pe-error">{{ error }}</p>
  <p v-else-if="hint !== ''" class="pe-hint">{{ hint }}</p>

  <div class="pe-actions">
    <button class="pe-btn" :disabled="busy" @click="save">保存 LLM 设置</button>
  </div>
</template>

<style scoped>
.pe-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
}

.pe-field-row {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
}

.pe-field label {
  color: var(--muted, #9aa3b2);
}

.pe-note {
  flex-basis: 100%;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted, #9aa3b2);
  opacity: 0.8;
}

.pe-input {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 4px 8px;
}

.pe-input-num {
  width: 96px;
}

.pe-error {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--danger, #ff7b72);
}

.pe-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--accent, #6ea8fe);
}

.pe-actions {
  display: flex;
  gap: 8px;
}

.pe-btn {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}

.pe-btn:hover:not(:disabled) {
  border-color: var(--accent, #6ea8fe);
  color: var(--accent, #6ea8fe);
}

.pe-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
