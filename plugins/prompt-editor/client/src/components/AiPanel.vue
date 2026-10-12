<script setup lang="ts">
/**
 * AI 辅助面板（D27）：全局入口 —— 指令 + 模板 + 多选可改块 + 是否允许新建。
 * 只把结果「讲出来」，落地由 App 走人类同款路径（重新拉草稿 / PUT 条目）。
 */
import { ref, watch } from 'vue';

import {
  fetchLlmPrompts,
  generateLlm,
  type LlmGenerateOutcome,
  type LlmPrompt,
  type LlmSuggestion,
} from '../api';
import type { Block } from '../model';

const props = defineProps<{ open: boolean; blocks: Block[] }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'generated', outcome: LlmGenerateOutcome): void;
  (e: 'apply-suggestion', suggestion: LlmSuggestion): void;
}>();

const prompts = ref<LlmPrompt[]>([]);
const promptId = ref('');
const instruction = ref('');
const selectedIds = ref<string[]>([]);
const allowCreate = ref(true);
const busy = ref(false);
const error = ref('');
const outcome = ref<LlmGenerateOutcome | null>(null);
const applied = ref<Set<string>>(new Set());

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    error.value = '';
    outcome.value = null;
    instruction.value = '';
    applied.value = new Set();
    // 默认全选带 AI 标记的块（LLM 可改的那批）；没有就空着，等用户勾
    selectedIds.value = props.blocks.filter((block) => block.ai).map((block) => block.id);
    try {
      prompts.value = await fetchLlmPrompts();
      promptId.value = prompts.value[0]?.id ?? '';
    } catch (err) {
      error.value = `读模板失败：${(err as Error).message}`;
    }
  },
);

async function submit(): Promise<void> {
  const text = instruction.value.trim();
  if (text === '') {
    error.value = '先写一句想让 AI 做什么。';
    return;
  }
  busy.value = true;
  error.value = '';
  outcome.value = null;
  try {
    outcome.value = await generateLlm({
      instruction: text,
      promptId: promptId.value === '' ? undefined : promptId.value,
      blockIds: selectedIds.value,
      allowCreate: allowCreate.value,
    });
    emit('generated', outcome.value);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

function apply(suggestion: LlmSuggestion): void {
  emit('apply-suggestion', suggestion);
  applied.value = new Set(applied.value).add(suggestion.blockId);
}
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>AI 辅助</strong>
        <button class="pe-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <div class="pe-field">
        <label>指令</label>
        <textarea v-model="instruction" class="pe-input pe-textarea" rows="4" placeholder="例如：把主体块扩成 5 个更具体的 tag"></textarea>
        <p class="pe-note">一次提交 = 1 次调用；AI 只能改你勾选的 AI 块，勾不上就写成建议。</p>
      </div>

      <div class="pe-field">
        <label>模板</label>
        <select v-model="promptId" class="pe-input">
          <option v-for="prompt in prompts" :key="prompt.id" :value="prompt.id">{{ prompt.name }}</option>
        </select>
      </div>

      <div class="pe-field">
        <label>可改的块（带 AI 标记的默认全选）</label>
        <div class="pe-blocks">
          <label v-for="block in blocks" :key="block.id" class="pe-block-option">
            <input v-model="selectedIds" type="checkbox" :value="block.id" />
            <span>{{ block.title === '' ? `区块 ${block.id.slice(0, 8)}` : block.title }}</span>
            <span class="pe-note">{{ block.mode }} · {{ block.items.length }} 条{{ block.ai ? '' : '（只读，只能出建议）' }}</span>
          </label>
        </div>
      </div>

      <div class="pe-field pe-field-row">
        <label>
          <input v-model="allowCreate" type="checkbox" />
          允许新建块
        </label>
        <p class="pe-note">勾上后 AI 可以按需要创建带 AI 标记的新区块。</p>
      </div>

      <p v-if="error !== ''" class="pe-error">{{ error }}</p>

      <div v-if="outcome !== null" class="pe-outcome">
        <p v-if="outcome.error !== undefined" class="pe-error">生成出错：{{ outcome.error.message }}（已写的块不会回滚）</p>
        <p class="pe-summary">{{ outcome.summary }}</p>
        <p class="pe-note">
          改了 {{ outcome.changed.length }} 块 · 新建 {{ outcome.created.length }} 块 · 删了 {{ outcome.deleted.length }} 块
          · 工具调用 {{ outcome.toolCalls.length }} 轮{{ outcome.aborted === true ? '（超时中止）' : '' }}
        </p>
        <div v-for="suggestion in outcome.suggestions" :key="`${suggestion.blockId}-${suggestion.content}`" class="pe-suggestion">
          <p class="pe-note">
            {{ blocks.find((block) => block.id === suggestion.blockId)?.title ?? suggestion.blockId }}
          </p>
          <pre class="pe-suggestion-text">{{ suggestion.content }}</pre>
          <button class="pe-btn" :disabled="applied.has(suggestion.blockId)" @click="apply(suggestion)">
            {{ applied.has(suggestion.blockId) ? '已应用' : '应用' }}
          </button>
        </div>
      </div>

      <div class="pe-actions">
        <button class="pe-btn" :disabled="busy" @click="submit">{{ busy ? '生成中…' : '生成' }}</button>
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
  width: min(560px, 92vw);
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

.pe-textarea {
  resize: vertical;
  line-height: 1.5;
}

.pe-blocks {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
}

.pe-block-option {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--fg, #e6e8ec);
}

.pe-outcome {
  margin: 10px 0;
  padding: 10px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel-2, #22262e);
}

.pe-summary {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--fg, #e6e8ec);
  white-space: pre-wrap;
}

.pe-suggestion {
  margin-top: 8px;
}

.pe-suggestion-text {
  margin: 4px 0;
  padding: 6px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  font: inherit;
  font-size: 11px;
  white-space: pre-wrap;
  color: var(--fg, #e6e8ec);
}

.pe-error {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--danger, #ff7b72);
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

  .pe-field-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
