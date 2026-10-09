<script setup lang="ts">
/**
 * 翻译设置：provider、自动译开关、护栏（每日上限 / 超时），外加"今天用了多少次、词库多少条"。
 *
 * 字段形状跟 `plugins/prompt-editor/package.json` 的 `plugin.settings[]` 对齐（宿主只提供清单，
 * 值由插件自己的 `GET/PUT /api/settings` 持有 —— key 之类的凭据永远不下发到浏览器）。
 */
import { ref, watch } from 'vue';

import { fetchSettings, saveSettings, type ProviderInfo, type TranslateSettings } from '../api';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', settings: TranslateSettings): void }>();

const draft = ref<TranslateSettings>({
  provider: 'youdao-demo',
  autoTranslate: true,
  maxCallsPerDay: 2000,
  timeoutMs: 8000,
  minIntervalMs: 6000,
});
const providers = ref<ProviderInfo[]>([]);
const usageCalls = ref(0);
const tagCount = ref(0);
const busy = ref(false);
const error = ref('');
const hint = ref('');

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    error.value = '';
    hint.value = '';
    try {
      const payload = await fetchSettings();
      draft.value = payload.settings;
      providers.value = payload.providers;
      usageCalls.value = payload.usage.calls;
      tagCount.value = payload.tagCount;
    } catch (err) {
      error.value = `读设置失败：${(err as Error).message}`;
    }
  },
);

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const next = await saveSettings(draft.value);
    draft.value = next;
    emit('saved', next);
    hint.value = '已保存';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>翻译</strong>
        <button class="pe-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <div class="pe-field">
        <label>翻译服务</label>
        <select v-model="draft.provider" class="pe-input">
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.label }}</option>
        </select>
        <p class="pe-note">
          译文由插件后端统一去拿（浏览器不接触任何凭据）。词库命中时**一个请求都不发**，
          没命中的才交给服务。
        </p>
      </div>

      <div class="pe-field pe-field-row">
        <label>
          <input v-model="draft.autoTranslate" type="checkbox" />
          新条目自动翻译
        </label>
        <p class="pe-note">
          条目编辑完（失焦）后自动去翻，连着敲几条会合并成一个队列、**逐条**发。已有译文的一律不动。
        </p>
      </div>

      <div class="pe-field pe-field-row">
        <label>两次调用最小间隔</label>
        <input v-model.number="draft.minIntervalMs" class="pe-input pe-input-num" type="number" min="0" max="60000" />
        <label>超时（毫秒）</label>
        <input v-model.number="draft.timeoutMs" class="pe-input pe-input-num" type="number" min="1000" max="30000" />
        <p class="pe-note">
          体验版限流很紧：实测约 6 次/窗口就返回「请求频率过快」，触发后要等几十秒到几分钟。
          默认 6000ms（实测 6s 间隔连打 8 次全过），所以一整块翻起来是要等的 —— 这也是
          "手改 / 存过的进词库、以后直接命中"的意义。
        </p>
      </div>

      <div class="pe-field pe-field-row">
        <label>每日调用上限</label>
        <input v-model.number="draft.maxCallsPerDay" class="pe-input pe-input-num" type="number" min="0" max="100000" />
        <p class="pe-note">
          护栏：烧光了只会让自动译停下（格子上留个记号），不会阻塞写作。0 = 只查词库、永不联网。
        </p>
      </div>

      <p class="pe-stat">
        今天已调用 {{ usageCalls }} 次 · 词库 {{ tagCount }} 条（在「词库…」面板里看和改）
      </p>

      <p v-if="error !== ''" class="pe-error">{{ error }}</p>
      <p v-else-if="hint !== ''" class="pe-hint">{{ hint }}</p>

      <div class="pe-actions">
        <button class="pe-btn" :disabled="busy" @click="save">保存</button>
        <button class="pe-btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pe-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.pe-panel {
  width: min(520px, 92vw);
  max-height: 86vh;
  overflow: auto;
  background: var(--panel, #1b1e24);
  border: 1px solid var(--line, #2e333d);
  border-radius: 10px;
  padding: 14px;
}

.pe-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.pe-close {
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font-size: 16px;
  cursor: pointer;
}

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

.pe-stat {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
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

@media (max-width: 720px) {
  .pe-overlay {
    align-items: stretch;
  }

  .pe-panel {
    width: 100%;
    height: 100vh;
    height: 100dvh;
    max-height: none;
    border: none;
    border-radius: 0;
    padding: 14px 14px calc(14px + env(safe-area-inset-bottom, 0px));
  }

  .pe-close {
    font-size: 24px;
    padding: 4px 10px;
  }

  /* 标签 + 数字框原来横着排：窄屏上会换行错位，一个字段一行才对得上 */
  .pe-field-row {
    flex-direction: column;
    align-items: stretch;
  }

  .pe-input-num {
    width: 100%;
  }

  .pe-actions .pe-btn {
    padding: 10px 16px;
  }
}
</style>
