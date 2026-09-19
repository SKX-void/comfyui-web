<script setup lang="ts">
/**
 * 单个模板字段的控件渲染。
 *
 * 只负责"把某个 input 画成控件并回报新值"，不含布局（布局在 TemplateForm）。
 * `tag-selector` / `lora-select` 走带数据源的专用组件。
 */
import type { TemplateInput } from '@comfyui-server/shared';
import TagSelector from '@/components/TagSelector.vue';
import LoraSelector, { type LoraValue } from '@/components/LoraSelector.vue';
import SelectMenu from '@/components/SelectMenu.vue';

const props = defineProps<{
  input: TemplateInput;
  value: unknown;
  /** model-select 的候选项：folder -> 模型名列表 */
  models: Record<string, string[]>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ update: [key: string, value: unknown] }>();

function set(v: unknown): void {
  emit('update', props.input.key, v);
}

function onInput(e: Event): void {
  set((e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
}
function onNumber(e: Event): void {
  const el = e.target as HTMLInputElement;
  set(el.value === '' ? '' : Number(el.value));
}
function onSwitch(e: Event): void {
  set((e.target as HTMLInputElement).checked);
}
/** 下拉选项：model-select 取模型列表；select 取模板里声明的静态选项 */
function optionsFor(input: TemplateInput): string[] {
  if (input.type === 'model-select') {
    return props.models[input.source?.folder ?? ''] ?? [];
  }
  return (input.source?.options ?? []).map((o) => o.value);
}

function lorasOf(): LoraValue[] {
  return Array.isArray(props.value) ? (props.value as LoraValue[]) : [];
}
</script>

<template>
  <!-- 标签选择器（WeiLin 标签库） -->
  <TagSelector
    v-if="props.input.type === 'tag-selector'"
    :model-value="String(props.value ?? '')"
    :placeholder="props.input.ui?.placeholder"
    :rows="props.input.ui?.rows"
    :disabled="props.disabled"
    @update:model-value="set($event)"
  />

  <!-- LoRA 选择器（WeiLin LoRA 索引） -->
  <LoraSelector
    v-else-if="props.input.type === 'lora-select'"
    :model-value="lorasOf()"
    :disabled="props.disabled"
    @update:model-value="set($event)"
  />

  <!-- 多行文本 -->
  <textarea
    v-else-if="props.input.type === 'textarea'"
    class="control"
    :rows="props.input.ui?.rows ?? 4"
    :placeholder="props.input.ui?.placeholder ?? ''"
    :disabled="props.disabled"
    :value="String(props.value ?? '')"
    @input="onInput"
  />

  <!-- 单行文本 -->
  <input
    v-else-if="props.input.type === 'text'"
    class="control"
    type="text"
    :placeholder="props.input.ui?.placeholder ?? ''"
    :disabled="props.disabled"
    :value="String(props.value ?? '')"
    @input="onInput"
  />

  <!-- 数字 / 种子 -->
  <input
    v-else-if="props.input.type === 'number' || props.input.type === 'seed'"
    class="control"
    type="number"
    :min="props.input.ui?.min"
    :max="props.input.ui?.max"
    :step="props.input.ui?.step ?? 1"
    :disabled="props.disabled"
    :value="props.value as number"
    @input="onNumber"
  />

  <!-- 开关 -->
  <label v-else-if="props.input.type === 'switch'" class="switch">
    <input
      type="checkbox"
      :disabled="props.disabled"
      :checked="Boolean(props.value)"
      @change="onSwitch"
    />
    <span>{{ props.value ? '开' : '关' }}</span>
  </label>

  <!-- 模型选择 / 静态枚举（自定义下拉：原生 select 无法美化，且不支持搜索） -->
  <SelectMenu
    v-else-if="props.input.type === 'model-select' || props.input.type === 'select'"
    :model-value="String(props.value ?? '')"
    :options="optionsFor(props.input)"
    :disabled="props.disabled"
    :placeholder="props.input.ui?.placeholder ?? '（请选择）'"
    @update:model-value="set($event)"
  />

  <!-- 兜底 -->
  <input
    v-else
    class="control"
    type="text"
    :disabled="props.disabled"
    :value="String(props.value ?? '')"
    @input="onInput"
  />
</template>

<style scoped>
.control {
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.control:focus {
  outline: none;
  border-color: #6366f1;
}
.control:disabled {
  opacity: 0.5;
}
.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #cbd5e1;
}
</style>
