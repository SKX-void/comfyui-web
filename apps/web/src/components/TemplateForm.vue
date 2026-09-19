<script setup lang="ts">
/**
 * 动态表单：由模板 inputs 渲染控件，并按 `ui.row` 分组布局。
 *
 * - 未声明 `ui.row` 的字段独占一行
 * - `ui.row` 相同的字段排在同一行（按首次出现顺序）
 * - 行内任意字段声明 `ui.swap: "<key>"` 时，该字段后出现 ⇄ 一键交换
 *
 * 控件本身的渲染见 FieldControl.vue。
 */
import { computed } from 'vue';
import type { TemplateInput } from '@comfyui-server/shared';
import { isVisible, type FieldModel } from '@/form';
import FieldControl from '@/components/FieldControl.vue';

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

function onUpdate(key: string, value: unknown): void {
  props.values[key] = value;
}

/** 一键交换两个字段的值（如宽 ⇄ 高） */
function swap(from: TemplateInput): void {
  const other = from.ui?.swap;
  if (!other) return;
  const a = props.values[from.key];
  const b = props.values[other];
  props.values[from.key] = b;
  props.values[other] = a;
}
</script>

<template>
  <form class="form" @submit.prevent>
    <template v-for="(item, idx) in layout" :key="idx">
      <!-- 独占一行 -->
      <div v-if="item.kind === 'single'" class="field">
        <label class="field-label">
          {{ item.inputs[0]!.label }}
          <span v-if="item.inputs[0]!.required" class="req">*</span>
        </label>
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
      <div v-else class="row">
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
}
.field-label {
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
  white-space: nowrap;
}
.req {
  color: #f87171;
}
.desc {
  font-size: 12px;
  color: #64748b;
  margin: 0;
}

/* 同行布局：短数值字段并排。
   flex-basis 取"刚好够放一个数字输入"的宽度：
   - 3 个字段在 280px 宽的手机上仍能排成一行（3×76 + 2×10 = 248）
   - 字段更多、或容器更窄时才换行，不会把 CFG 单独挤到下一行 */
.row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
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
