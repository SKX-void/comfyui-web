<script setup lang="ts">
/**
 * LLM 设置字段（D27）：enabled 是 /llm/* 的总闸。
 *
 * **key 只写不读**：`draft` 里只有 `apiKeySet`（后端有没有），输入框是另一个 ref，
 * 永远以空值开始、保存即清空 —— 浏览器里拿不到 key，重开面板也只能看到"有没有"。
 *
 * 保存只发 `llm` 段 —— 服务端 PUT /settings 是浅合并，翻译段不会被覆盖。
 */
import { onMounted, ref } from 'vue';

import { fetchSettings, saveSettings, type LlmSettings } from '../api';

const emit = defineEmits<{ (e: 'saved'): void }>();

const draft = ref<LlmSettings>({
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKeySet: false,
  timeoutMs: 60000,
  maxCallsPerDay: 200,
  newBlockColor: '#6ea8fe',
  maxToolRounds: 12,
});
/** 新 key 的输入框：单向流向（非空才发出去，发完就清空），从不从后端回填 */
const apiKey = ref('');
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

/** 写一次设置：`key` 传 null 表示清掉后端已存的那份 */
async function put(nextKey: string | null, okHint: string): Promise<void> {
  busy.value = true;
  error.value = '';
  hint.value = '';
  try {
    // 空串 = 服务端"不改动"，所以输入框空着保存不会把已存的 key 擦掉
    const saved = await saveSettings({ llm: { ...draft.value, apiKey: nextKey } });
    draft.value = saved.llm;
    apiKey.value = ''; // 保存即清空：这一框从不留 key
    hint.value = okHint;
    emit('saved');
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
      启用 LLM 辅助（总闸）
    </label>
    <p class="pe-note">
      关掉时 /llm/* 一律 403，工作区下面的 AI 卡片整个消失（手机上「AI」那一屏也一起收起来）——
      想再开就回这里。协议只做 OpenAI-compatible 的非流式 chat + tool calling；key **只写不读**：
      它只往服务端流，这一页只能看到后端有没有，浏览器永远拿不到它。
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
    <input
      v-model="apiKey"
      class="pe-input"
      type="password"
      :placeholder="draft.apiKeySet ? '已存 key：留空 = 不改动' : '只写不读：存到后端'"
      autocomplete="new-password"
    />
    <span class="pe-key-state">{{ draft.apiKeySet ? '后端已有 key（看不到内容）' : '后端还没有 key' }}</span>
    <button v-if="draft.apiKeySet" class="pe-btn" :disabled="busy" @click="put(null, '已清除后端的 key')">
      清除
    </button>
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
    <button class="pe-btn" :disabled="busy" @click="put(apiKey, '已保存')">保存 LLM 设置</button>
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

/* key 的"有没有"提示：跟着输入框排在同一行 */
.pe-key-state {
  font-size: 11px;
  color: var(--muted, #9aa3b2);
  opacity: 0.8;
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
