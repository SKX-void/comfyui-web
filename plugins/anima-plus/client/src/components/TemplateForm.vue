<script setup lang="ts">
/**
 * 动态表单：由模板 inputs 渲染控件，并按 `ui.row` 分组布局。
 *
 * - 未声明 `ui.row` 的字段独占一行
 * - `ui.row` 相同的字段排在同一行（按首次出现顺序）
 * - 行内任意字段声明 `ui.swap: "<key>"` 时，该字段后出现 ⇄ 一键交换
 * - 字段声明 `ui.preset` 时出现预设切换器（单字段在标签行右侧，
 *   整行则在行上方；`targets` 决定预设覆盖哪些字段）
 *
 * 控件本身的渲染见 FieldControl.vue。
 */
import { computed } from 'vue';
import type { TemplateInput } from '@comfyui-web/shared';
import { isVisible, type FieldModel } from '@/form';
import { applyPreset } from '@/presets';
import FieldControl from '@/components/FieldControl.vue';
import PresetPicker from '@/components/PresetPicker.vue';

const props = defineProps<{
  inputs: TemplateInput[];
  values: FieldModel;
  models: Record<string, string[]>;
  disabled?: boolean;
}>();

interface LayoutItem {
  kind: 'single' | 'row';
  inputs: TemplateInput[];
}

/** 把 inputs 折叠成「独占一行」与「同行分组」两种布局项 */
const layout = computed<LayoutItem[]>(() => {
  const items: LayoutItem[] = [];
  const rowAt = new Map<string, number>();

  for (const input of props.inputs ?? []) {
    if (!isVisible(input, props.values)) continue;

    const row = input.ui?.row;
    if (!row) {
      items.push({ kind: 'single', inputs: [input] });
      continue;
    }
    const at = rowAt.get(row);
    if (at === undefined) {
      rowAt.set(row, items.length);
      items.push({ kind: 'row', inputs: [input] });
    } else {
      items[at]!.inputs.push(input);
    }
  }
  return items;
});

const allKeys = computed(() => (props.inputs ?? []).map((i) => i.key));

/** 归一化 ui.preset：字符串 = kind，目标为自身；对象可取显式 targets */
function presetSpec(input: TemplateInput): { kind: string; targets: string[] } | null {
  const p = input.ui?.preset;
  if (!p) return null;
  if (typeof p === 'string') return { kind: p, targets: [input.key] };
  return { kind: p.kind, targets: p.targets ?? [input.key] };
}

/** 行内任一字段声明了 preset 就用它（一行只渲染一个切换器） */
function rowPreset(item: LayoutItem): { kind: string; targets: string[] } | null {
  for (const input of item.inputs) {
    const spec = presetSpec(input);
    if (spec) return spec;
  }
  return null;
}

function onUpdate(key: string, value: unknown): void {
  props.values[key] = value;
}

/** 一键交换两个字段的值（如宽 ⇄ 高） */
function swap(from: TemplateInput): void {
  const other = from.ui?.swap;
  if (!other) return;
  const a = props.values[from.key];
  props.values[from.key] = props.values[other];
  props.values[other] = a;
}

/** 套用预设：只写「对应得上模板 input」的键，保留键自动跳过 */
function onApplyPreset(values: Record<string, unknown>): void {
  applyPreset(props.values, allKeys.value, values);
}
</script>

<template>
  <form class="form" @submit.prevent>
    <template v-for="(item, idx) in layout" :key="idx">
      <!-- 独占一行 -->
      <div v-if="item.kind === 'single'" class="field">
        <div class="field-head">
          <label class="field-label">
            {{ item.inputs[0]!.label }}
            <span v-if="item.inputs[0]!.required" class="req">*</span>
          </label>
          <PresetPicker
            v-if="presetSpec(item.inputs[0]!)"
            :kind="presetSpec(item.inputs[0]!)!.kind"
            :targets="presetSpec(item.inputs[0]!)!.targets"
            :values="props.values"
            :disabled="props.disabled"
            @apply="onApplyPreset"
          />
        </div>
        <FieldControl
          :input="item.inputs[0]!"
          :value="props.values[item.inputs[0]!.key]"
          :models="props.models"
          :disabled="props.disabled"
          @update="onUpdate"
        />
        <p v-if="item.inputs[0]!.description" class="desc">
          {{ item.inputs[0]!.description }}
        </p>
      </div>

      <!-- 同行分组 -->
      <div v-else class="row-group">
        <div v-if="rowPreset(item)" class="row-head">
          <PresetPicker
            :kind="rowPreset(item)!.kind"
            :targets="rowPreset(item)!.targets"
            :values="props.values"
            :disabled="props.disabled"
            @apply="onApplyPreset"
          />
        </div>
        <div class="row">
          <template v-for="input in item.inputs" :key="input.key">
            <div class="row-field">
              <label class="field-label">
                {{ input.label }}
                <span v-if="input.required" class="req">*</span>
              </label>
              <FieldControl
                :input="input"
                :value="props.values[input.key]"
                :models="props.models"
                :disabled="props.disabled"
                @update="onUpdate"
              />
              <!-- 说明挂在自己字段下面：挂在整行下方时，"−1 表示每次随机"看着像 CFG 的 -->
              <p v-if="input.description" class="row-desc">{{ input.description }}</p>
            </div>
            <button
              v-if="input.ui?.swap"
              type="button"
              class="swap"
              :disabled="props.disabled"
              :title="`交换 ${input.label} 与 ${item.inputs.find((i) => i.key === input.ui!.swap)?.label ?? input.ui!.swap}`"
              @click="swap(input)"
            >
              ⇄
            </button>
          </template>
        </div>
      </div>
    </template>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 每一级容器都放开收缩下限：只要有一级是 min-width:auto，
     里面的数字框（种子那种固有宽度 ~20 字符）就能把整行顶出视口 */
  min-width: 0;
}
.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.field-label {
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
  white-space: nowrap;
  /* 长标签不许把整行顶宽（窄屏上宁可省略号） */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.req {
  color: #f87171;
}
.desc {
  font-size: 12px;
  color: #64748b;
  margin: 0;
}
/* 行内字段的说明：独占一行单字段的 .desc 同款观感，只是更小一号 */
.row-desc {
  font-size: 11px;
  color: #64748b;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 同行布局：短数值字段并排。
   flex-basis 取"刚好够放一个数字输入"的宽度：
   - 3 个字段在 280px 宽的手机上仍能排成一行（3×76 + 2×10 = 248）
   - 字段更多、或容器更窄时才换行，不会把 CFG 单独挤到下一行 */
.row-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.row-head {
  display: flex;
  justify-content: flex-end;
}
.row {
  display: flex;
  /* 顶端对齐：每个字段是 [标签][控件][说明]，标签都是单行所以控件必然对齐，
     说明只往下长，不会把带说明的那个控件顶起来（原来 flex-end 就会） */
  align-items: flex-start;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.row-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 76px;
  min-width: 0;
}
.row-field .field-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.swap {
  flex: 0 0 auto;
  /* 行是顶端对齐，这个按钮要和控件底部齐平 */
  align-self: flex-end;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #93c5fd;
  font-size: 15px;
  line-height: 1;
  padding: 8px 10px;
  cursor: pointer;
  margin-bottom: 1px;
}
.swap:hover:not(:disabled) {
  border-color: #6366f1;
  color: #c7d2fe;
}
.swap:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
