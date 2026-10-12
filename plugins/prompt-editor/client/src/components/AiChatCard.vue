<script setup lang="ts">
/**
 * AI 辅助卡片（D28）：多轮对话，**不是弹层** —— 桌面停在工作区下面，手机里和工作区平行一屏。
 *
 * 为什么是卡片：对话是"边聊边看块变化"的活儿，弹层一盖住工作区就看不见 AI 刚写进去的东西。
 *
 * 分工：卡片只管"说"与"看"（会话、消息、选中哪些块），
 * 真正的落盘 / 回读草稿 / 补翻译由 App 接 `changed` 事件后统一做（见 App.onLlmTurn）。
 */
import { onMounted, ref, watch } from 'vue';

import { ApiError } from '../api-core';
import type { LlmReasoning } from '../api';
import { fetchLlmPrompts, type LlmPrompt, type LlmSuggestion } from '../api-llm';
import {
  createChat,
  deleteChat,
  fetchChat,
  fetchChats,
  sendChatMessage,
  type LlmChatSummary,
  type LlmTurn,
} from '../api-llm-chat';
import type { Block } from '../model';

const props = defineProps<{ blocks: Block[]; version?: number; enabled: boolean }>();
const emit = defineEmits<{
  (e: 'open-settings'): void;
  (e: 'changed', turn: LlmTurn): void;
  (e: 'apply-suggestion', suggestion: LlmSuggestion): void;
}>();

const chats = ref<LlmChatSummary[]>([]);
const activeId = ref('');
const turns = ref<LlmTurn[]>([]);
const prompts = ref<LlmPrompt[]>([]);
const promptId = ref('');
const instruction = ref('');
const allowCreate = ref(true);
/** 推理强度（D29）：单次请求的参数，不落盘；请求体里 reasoning_effort 与 thinking.type 都显式发 */
const reasoning = ref<LlmReasoning>('off');
const busy = ref(false);
const error = ref('');
/** 总闸没开：整张卡只显示"去设置"，连模板都不拉 */
const disabled = ref(false);
const confirmDelete = ref(false);
/** 已经点过「应用」的建议（按 轮次-块 记）：防止同一条建议重复落地 */
const applied = ref(new Set<string>());

const selectedIds = ref<string[]>([]);
/** 人动过勾选之后就别再自动跟随块列表，否则他取消掉的块会被"新块出现"顺手勾回来 */
let picked = false;

const aiBlocks = () => props.blocks.filter((block) => block.ai);
const blockTitle = (id: string): string => props.blocks.find((block) => block.id === id)?.title ?? id;
const appliedKey = (index: number, blockId: string): string => `${index}-${blockId}`;

watch(
  () => props.blocks,
  () => {
    const ids = aiBlocks().map((block) => block.id);
    selectedIds.value = picked ? selectedIds.value.filter((id) => ids.includes(id)) : ids;
  },
  { immediate: true, deep: true },
);

async function refresh(): Promise<void> {
  error.value = '';
  disabled.value = false;
  try {
    const [list, promptList] = await Promise.all([fetchChats(), fetchLlmPrompts()]);
    prompts.value = promptList;
    if (promptId.value === '') promptId.value = promptList[0]?.id ?? '';
    chats.value = list;
    if (!list.some((one) => one.id === activeId.value)) activeId.value = list[0]?.id ?? '';
    await loadTurns();
  } catch (err) {
    // 总闸关着不是错误，是"还没配"：卡片换成一句说明 + 去设置的入口
    if (err instanceof ApiError && err.code === 'LLM_DISABLED') {
      disabled.value = true;
      return;
    }
    error.value = `读对话失败：${(err as Error).message}`;
  }
}

async function loadTurns(): Promise<void> {
  turns.value = activeId.value === '' ? [] : (await fetchChat(activeId.value)).turns;
}

/**
 * 总闸关着就**一个请求都不发**（会话列表和模板都不拉）：装好默认就是关的，
 * 不该为没开的功能每次装载都打两个 403。所以总闸状态由 App 从设置里传进来（`enabled`）。
 */
function sync(): void {
  if (!props.enabled) {
    disabled.value = true;
    chats.value = [];
    turns.value = [];
    return;
  }
  void refresh();
}

onMounted(sync);
watch(() => [props.enabled, props.version ?? 0] as const, sync);

function onPick(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  activeId.value = id;
  confirmDelete.value = false;
  error.value = '';
  void loadTurns().catch((err: unknown) => {
    error.value = (err as Error).message;
  });
}

async function newChat(): Promise<void> {
  error.value = '';
  confirmDelete.value = false;
  try {
    const chat = await createChat();
    chats.value = [{ ...chat, turns: 0 }, ...chats.value];
    activeId.value = chat.id;
    turns.value = [];
    focus();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function removeChat(): Promise<void> {
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  error.value = '';
  try {
    await deleteChat(activeId.value);
    chats.value = chats.value.filter((one) => one.id !== activeId.value);
    activeId.value = chats.value[0]?.id ?? '';
    confirmDelete.value = false;
    await loadTurns();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function send(): Promise<void> {
  const text = instruction.value.trim();
  if (text === '') {
    error.value = '先写一句想让 AI 做什么。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    if (activeId.value === '') {
      const chat = await createChat();
      chats.value = [{ ...chat, turns: 0 }, ...chats.value];
      activeId.value = chat.id;
      turns.value = [];
    }
    const result = await sendChatMessage(activeId.value, {
      instruction: text,
      promptId: promptId.value === '' ? undefined : promptId.value,
      blockIds: selectedIds.value,
      allowCreate: allowCreate.value,
      reasoning: reasoning.value,
    });
    turns.value = [...turns.value, result.turn];
    chats.value = chats.value.map((one) => (one.id === result.chat.id ? result.chat : one));
    instruction.value = '';
    emit('changed', result.turn);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

function applySuggestion(index: number, suggestion: LlmSuggestion): void {
  applied.value = new Set(applied.value).add(appliedKey(index, suggestion.blockId));
  emit('apply-suggestion', suggestion);
}

function togglePick(): void {
  picked = true;
}
</script>

<template>
  <section class="pe-ai">
    <header class="pe-ai-head">
      <strong class="pe-ai-title">AI 辅助</strong>
      <select v-if="chats.length > 0" class="pe-ai-select" :value="activeId" @change="onPick">
        <option v-for="chat in chats" :key="chat.id" :value="chat.id">{{ chat.title }}（{{ chat.turns }} 轮）</option>
      </select>
      <span v-else class="pe-ai-empty-hint">还没有对话</span>
      <button class="pe-btn-mini" @click="newChat">新对话</button>
      <button v-if="activeId !== ''" class="pe-btn-mini" @click="removeChat">
        {{ confirmDelete ? '确认删除' : '删除' }}
      </button>
      <button class="pe-btn-mini" @click="emit('open-settings')">设置</button>
    </header>

    <p v-if="disabled" class="pe-note">
      LLM 功能未启用：在「LLM 设置」里勾上「启用 LLM 辅助」，并填 baseUrl / 模型 / apiKey。设置存在插件自己的空间里，key
      只落后端。
    </p>

    <template v-else>
      <div class="pe-ai-log">
        <p v-if="turns.length === 0" class="pe-note">
          开个话头吧：AI 只能改你勾选的 AI 块，其它块它会写成建议让你自己决定要不要用。
        </p>
        <article v-for="(turn, index) in turns" :key="`${turn.at}-${index}`" class="pe-ai-turn">
          <p class="pe-ai-user">{{ turn.instruction }}</p>
          <p class="pe-ai-reply">{{ turn.reply === '' ? '（这次没有回复）' : turn.reply }}</p>
          <p class="pe-ai-action">
            {{ turn.action }}
            <span v-if="turn.aborted"> · 达到轮数上限，提前收工</span>
            <span v-if="turn.error"> · 出错：{{ turn.error.message }}</span>
          </p>
          <div v-for="suggestion in turn.suggestions" :key="suggestion.blockId" class="pe-ai-suggestion">
            <span class="pe-ai-suggestion-text">
              <b>{{ blockTitle(suggestion.blockId) }}</b
              >：{{ suggestion.content }}
            </span>
            <button
              class="pe-btn-mini"
              :disabled="applied.has(appliedKey(index, suggestion.blockId))"
              @click="applySuggestion(index, suggestion)"
            >
              {{ applied.has(appliedKey(index, suggestion.blockId)) ? '已应用' : '应用' }}
            </button>
          </div>
        </article>
      </div>

      <div class="pe-ai-form">
        <textarea
          v-model="instruction"
          class="pe-input pe-ai-textarea"
          rows="3"
          placeholder="想让 AI 做什么？比如：把质量块写强一点，再补两个场景"
          @keydown.ctrl.enter="send"
          @keydown.meta.enter="send"
        />
        <div class="pe-ai-row">
          <label class="pe-ai-label">
            模板
            <select v-model="promptId" class="pe-input pe-ai-select">
              <option v-for="prompt in prompts" :key="prompt.id" :value="prompt.id">{{ prompt.name }}</option>
            </select>
          </label>
          <label class="pe-ai-label">
            推理强度
            <select v-model="reasoning" class="pe-input pe-ai-select">
              <option value="off">关 off</option>
              <option value="low">低 low</option>
              <option value="high">高 high</option>
            </select>
          </label>
          <label class="pe-ai-check">
            <input v-model="allowCreate" type="checkbox" />
            允许新建块
          </label>
        </div>
        <details class="pe-ai-blocks">
          <summary>可改的块（已选 {{ selectedIds.length }} / 共 {{ aiBlocks().length }}）</summary>
          <p class="pe-note">哪些块能被改，由区块表头的「AI」按钮决定（在「不使用」开关右边）。</p>
          <label v-for="block in aiBlocks()" :key="block.id" class="pe-ai-check">
            <input v-model="selectedIds" type="checkbox" :value="block.id" @change="togglePick" />
            {{ block.title }} · {{ block.mode }}
          </label>
          <p v-if="aiBlocks().length === 0" class="pe-note">
            还没有交给 AI 的块：在区块表头点一下「AI」，或者让 AI 新建一块。
          </p>
        </details>
        <p v-if="error !== ''" class="pe-error">{{ error }}</p>
        <div class="pe-ai-actions">
          <span class="pe-note">Ctrl / ⌘ + Enter 发送</span>
          <button class="pe-btn" :disabled="busy" @click="send">{{ busy ? '生成中…' : '发送' }}</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.pe-ai {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px 12px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
}

.pe-ai-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pe-ai-title {
  font-size: 13px;
}

.pe-ai-empty-hint {
  color: var(--muted, #9aa3b2);
  font-size: 12px;
}

.pe-ai-select {
  flex: 1;
  min-width: 120px;
}

.pe-btn-mini {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 3px 8px;
  cursor: pointer;
}

.pe-btn-mini:hover:not(:disabled) {
  border-color: var(--accent, #6ea8fe);
}

.pe-btn-mini:disabled {
  opacity: 0.5;
  cursor: default;
}

.pe-ai-log {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 46vh;
  overflow-y: auto;
  padding-right: 2px;
}

.pe-ai-turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}

.pe-ai-user {
  margin: 0;
  align-self: flex-end;
  max-width: 88%;
  padding: 5px 9px;
  border-radius: 8px 8px 2px 8px;
  background: var(--panel-2, #22262e);
  font-size: 13px;
  white-space: pre-wrap;
}

.pe-ai-reply {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.pe-ai-action {
  margin: 0;
  color: var(--muted, #9aa3b2);
  font-size: 12px;
}

.pe-ai-suggestion {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border: 1px dashed var(--line, #2e333d);
  border-radius: 6px;
  font-size: 12px;
}

.pe-ai-suggestion-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.pe-ai-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--line, #2e333d);
  padding-top: 10px;
}

.pe-ai-textarea {
  resize: vertical;
  font: inherit;
}

.pe-ai-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.pe-ai-label,
.pe-ai-check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted, #9aa3b2);
  font-size: 12px;
}

.pe-ai-blocks {
  font-size: 12px;
  color: var(--muted, #9aa3b2);
}

.pe-ai-blocks summary {
  cursor: pointer;
}

.pe-ai-blocks .pe-ai-check {
  display: flex;
  padding: 2px 0;
  color: inherit;
}

.pe-ai-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pe-input {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 5px 8px;
}

.pe-note {
  margin: 0;
  color: var(--muted, #9aa3b2);
  font-size: 12px;
  line-height: 1.5;
}

.pe-error {
  margin: 0;
  color: var(--danger, #ff6b6b);
  font-size: 12px;
}

.pe-btn {
  border: 1px solid var(--accent, #6ea8fe);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 5px 14px;
  cursor: pointer;
}

.pe-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
