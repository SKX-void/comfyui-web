<script setup lang="ts">
/**
 * 提示词预设（D30）：一份预设 = **有序分段**，像 SillyTavern 的 prompt manager ——
 * 每段能单独开关、上下挪、选角色；生成时启用的段按顺序拼起来
 * （system 段拼成一条 system 消息，user / assistant 段各成一条消息，排在本次指令之前）。
 *
 * `{{workspace}}`（工作区快照）与 `{{instruction}}`（你这次的指令）由后端插值；写错变量名会被置空并记日志。
 */
import { ArrowDown, ArrowUp, X } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';

import { fetchLlmPrompts, saveLlmPrompts, type LlmPrompt, type LlmPromptRole, type LlmPromptSegment } from '../api-llm';
import { newId } from '../model';

const emit = defineEmits<{ (e: 'saved'): void }>();

const ROLES: { value: LlmPromptRole; label: string }[] = [
  { value: 'system', label: 'system（拼进系统提示）' },
  { value: 'user', label: 'user（当一条用户消息）' },
  { value: 'assistant', label: 'assistant（当一条助手消息，示例用）' },
];

/** 变量提示写在 script 里：模板里直接写双层花括号会被 Vue 解析器当成插值（编译报错） */
const VAR_HINT = '{{workspace}} = 工作区快照，{{instruction}} = 你这次的指令；写错变量名会被置空并记一条日志。';

const prompts = ref<LlmPrompt[]>([]);
const activeId = ref('');
const busy = ref(false);
const error = ref('');
const hint = ref('');

const active = computed(() => prompts.value.find((one) => one.id === activeId.value) ?? null);

function newSegment(name = '新分段'): LlmPromptSegment {
  return { id: newId(), name, content: '', enabled: true, role: 'system' };
}

onMounted(async () => {
  try {
    prompts.value = await fetchLlmPrompts();
    activeId.value = prompts.value[0]?.id ?? '';
  } catch (err) {
    error.value = `读提示词失败：${(err as Error).message}`;
  }
});

function addPrompt(): void {
  const prompt: LlmPrompt = { id: newId(), name: `模板 ${prompts.value.length + 1}`, segments: [newSegment('角色')], updatedAt: 0 };
  prompts.value.push(prompt);
  activeId.value = prompt.id;
  hint.value = '新预设还没保存';
}

function removePrompt(): void {
  const index = prompts.value.findIndex((one) => one.id === activeId.value);
  if (index < 0) return;
  prompts.value.splice(index, 1);
  activeId.value = prompts.value[Math.max(0, index - 1)]?.id ?? '';
  hint.value = '删掉了，记得保存';
}

function addSegment(): void {
  active.value?.segments.push(newSegment());
}

function removeSegment(index: number): void {
  active.value?.segments.splice(index, 1);
}

/** 上下挪一段：顺序就是拼接顺序 */
function move(index: number, delta: number): void {
  const list = active.value?.segments;
  if (list === undefined) return;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [one] = list.splice(index, 1);
  if (one !== undefined) list.splice(target, 0, one);
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  hint.value = '';
  try {
    const saved = await saveLlmPrompts(
      prompts.value.map((one) => ({ id: one.id, name: one.name, segments: one.segments })),
    );
    prompts.value = saved;
    if (!saved.some((one) => one.id === activeId.value)) activeId.value = saved[0]?.id ?? '';
    hint.value = '已保存';
    emit('saved');
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 恢复默认 = 存一份空列表：后端下次读发现一份都没有，会把产物里那份默认写回来 */
async function restoreDefaults(): Promise<void> {
  busy.value = true;
  error.value = '';
  hint.value = '';
  try {
    const saved = await saveLlmPrompts([]);
    prompts.value = await fetchLlmPrompts();
    activeId.value = saved[0]?.id ?? prompts.value[0]?.id ?? '';
    hint.value = '已恢复产物默认';
    emit('saved');
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="pe-field pe-field-row">
    <label>预设</label>
    <select v-model="activeId" class="pe-input">
      <option v-for="one in prompts" :key="one.id" :value="one.id">{{ one.name === '' ? '(没名字)' : one.name }}</option>
    </select>
    <button class="pe-btn" @click="addPrompt">新建预设</button>
    <button class="pe-btn" :disabled="active === null" @click="removePrompt">删除预设</button>
    <button class="pe-btn" :disabled="busy" @click="restoreDefaults">恢复默认</button>
    <p class="pe-note">
      生成时把启用的段**按顺序拼起来**：system 段接成一条系统提示，user / assistant 段各成一条消息（排在本次指令之前）。
      变量：{{ VAR_HINT }}
    </p>
  </div>

  <div v-if="active !== null" class="pe-field">
    <label>预设名字</label>
    <input v-model="active.name" class="pe-input" type="text" maxlength="120" placeholder="预设名字" />

    <div v-for="(segment, index) in active.segments" :key="segment.id" class="pe-seg">
      <div class="pe-seg-head">
        <label class="pe-seg-toggle">
          <input v-model="segment.enabled" type="checkbox" />
          启用
        </label>
        <input v-model="segment.name" class="pe-input pe-seg-name" type="text" maxlength="120" placeholder="这段叫什么" />
        <select v-model="segment.role" class="pe-input">
          <option v-for="role in ROLES" :key="role.value" :value="role.value">{{ role.label }}</option>
        </select>
        <button class="pe-btn pe-btn-icon" :disabled="index === 0" title="上移" @click="move(index, -1)">
          <ArrowUp :size="14" />
        </button>
        <button
          class="pe-btn pe-btn-icon"
          :disabled="index === active.segments.length - 1"
          title="下移"
          @click="move(index, 1)"
        >
          <ArrowDown :size="14" />
        </button>
        <button class="pe-btn pe-btn-icon" title="删掉这段" @click="removeSegment(index)"><X :size="14" /></button>
      </div>
      <textarea v-model="segment.content" class="pe-input pe-seg-body" rows="4" placeholder="这一段的内容"></textarea>
    </div>

    <button class="pe-btn" @click="addSegment">+ 加一段</button>
  </div>

  <p v-if="error !== ''" class="pe-error">{{ error }}</p>
  <p v-else-if="hint !== ''" class="pe-hint">{{ hint }}</p>

  <div class="pe-actions">
    <button class="pe-btn" :disabled="busy" @click="save">保存提示词</button>
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

.pe-seg {
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
}

.pe-seg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.pe-seg-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted, #9aa3b2);
}

.pe-seg-name {
  width: 140px;
}

.pe-seg-body {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  line-height: 1.5;
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

/* 纯图标按钮：图标自己撑开盒子，别被文字的左右内边距挤成一小条 */
.pe-btn-icon {
  display: inline-flex;
  align-items: center;
  padding: 4px 6px;
}

.pe-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
