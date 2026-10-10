<script setup lang="ts">
/**
 * 单个工作流字段的控件渲染。
 *
 * 只负责"把某个 input 画成控件并回报新值"，不含布局（布局在 WorkflowForm）。
 * `tag-selector` / `lora-select` 走带数据源的专用组件。
 */
import { computed } from 'vue';
import type { WorkflowInput } from '@comfyui-web/shared';
import { drawSeed } from '@/form';
import TagSelector from '@/components/TagSelector.vue';
import LoraSelector from '@/components/LoraSelector.vue';
import type { LoraValue } from '@/composables/useLoraSelection';
import SelectMenu from '@/components/SelectMenu.vue';

const props = defineProps<{
  input: WorkflowInput;
  value: unknown;
  /** model-select 的候选项：folder -> 模型名列表 */
  models: Record<string, string[]>;
  /** 同行的「随机」开关是否为开（只有 seed 控件用；未声明时按"开"处理） */
  randomSeed?: boolean;
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
/**
 * 种子框是否只读：由同行的「随机」开关决定。
 *
 * 随机开启时**不能手动改**（🎲 也一并禁用）—— 种子在点「开始出图」那一刻由 App.vue 抽定，
 * 这里的值只是"上一轮抽到什么"的展示（见 App.vue 的 submit）。
 */
const seedLocked = computed(() => props.input.type === 'seed' && props.randomSeed !== false);

/**
 * 手动摇一次：只有随机关闭时可用，摇出来的数立刻变成这次要跑的固定种子。
 *
 * 跟随机模式的区别在于"什么时候定下来"—— 随机模式是提交那一刻定，这里是用户点按钮那一刻定。
 */
function rerollSeed(): void {
  if (seedLocked.value) return;
  set(drawSeed());
}
/** 下拉选项：model-select 取模型列表；select 取模板里声明的静态选项 */
function optionsFor(input: WorkflowInput): string[] {
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

  <!-- 数字 -->
  <input
    v-else-if="props.input.type === 'number'"
    class="control"
    type="number"
    :min="props.input.ui?.min"
    :max="props.input.ui?.max"
    :step="props.input.ui?.step ?? 1"
    :disabled="props.disabled"
    :value="props.value as number"
    @input="onNumber"
  />

  <!--
    种子：随机开时只读 + 🎲 禁用（值 = 上一次抽到的，或还没抽过的默认值）；
    随机关时可以手填，也可以用 🎲 摇一个 —— 摇出来的数就是这次要跑的固定种子。
  -->
  <div v-else-if="props.input.type === 'seed'" class="seed-input-row">
    <input
      class="control"
      type="number"
      :min="props.input.ui?.min"
      :max="props.input.ui?.max"
      :step="props.input.ui?.step ?? 1"
      :readonly="seedLocked"
      :class="{ locked: seedLocked }"
      :disabled="props.disabled"
      :value="props.value as number"
      @input="onNumber"
    />
    <button
      type="button"
      class="seed-dice"
      :disabled="seedLocked || props.disabled"
      :title="seedLocked ? '随机已开启，种子在出图时自动抽' : '摇一个随机种子'"
      @click="rerollSeed"
    >
      🎲
    </button>
  </div>

  <!-- 开关：用 toggle 而不是原生 checkbox（checkbox 是"表单里打勾"，toggle 是"开/关一个状态"） -->
  <label v-else-if="props.input.type === 'switch'" class="toggle" :class="{ on: Boolean(props.value) }">
    <input
      class="toggle-input"
      type="checkbox"
      :disabled="props.disabled"
      :checked="Boolean(props.value)"
      @change="onSwitch"
    />
    <span class="toggle-track"><span class="toggle-knob"></span></span>
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
  /* 表单控件的"固有最小宽度"约 20 个字符（`<input type="number">` 就是种子那类），
     不改掉它，flex/grid 轨道就会按它撑开、顶破视口 */
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.control:focus {
  outline: none;
  border-color: #6366f1;
}
.control:disabled {
  opacity: 0.5;
}
/* 只读的种子框：让"随机接管了"一眼可见，而不是看着像输入框坏了 */
.control.locked {
  background: rgba(148, 163, 184, 0.08);
  color: #94a3b8;
  cursor: not-allowed;
}
/* 种子输入 + 🎲：输入框吃掉剩余宽度，按钮固定宽度不被压扁 */
.seed-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* .control 自带 width:100%，在 flex 行里要改成"可伸缩"才不会把按钮挤出去 */
.seed-input-row .control {
  flex: 1 1 auto;
  width: auto;
}
.seed-dice {
  flex: 0 0 auto;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 14px;
  line-height: 1;
  padding: 8px 10px;
  cursor: pointer;
}
.seed-dice:hover:not(:disabled) {
  border-color: #6366f1;
  background: #263449;
}
.seed-dice:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* toggle 开关：轨道 + 滑块。视觉状态由 .on 驱动，真实的 checkbox 藏在下面 */
.toggle {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  /* 与 .control 同高（8px 上下内边距 + 13px 字号），同行时不至于错位 */
  padding: 6px 0;
}
.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-track {
  position: relative;
  display: block;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: #334155;
  transition: background 0.15s ease;
}
.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #94a3b8;
  transition:
    transform 0.15s ease,
    background 0.15s ease;
}
.toggle.on .toggle-track {
  background: #4f46e5;
}
.toggle.on .toggle-knob {
  transform: translateX(16px);
  background: #e2e8f0;
}
.toggle-input:disabled + .toggle-track {
  opacity: 0.5;
}
.toggle-input:focus-visible + .toggle-track {
  outline: 2px solid #6366f1;
  outline-offset: 2px;
}
</style>
