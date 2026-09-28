<script setup lang="ts">
/**
 * 动态表单：由模板 inputs 渲染控件，并按 `ui.row` 分组布局。
 *
 * - 未声明 `ui.row` 的字段独占一行
 * - `ui.row` 相同的字段排在同一行（按首次出现顺序）
 * - 行内任意字段声明 `ui.swap: "<key>"` 时，该字段后出现 ⇄ 一键交换
 * - 字段声明 `ui.preset` 时出现预设切换器（单字段在标签行右侧，
 *   分组行里贴在整行最右那一格的标签行右端）；`targets` 决定预设覆盖哪些字段
 * - 单字段声明 `ui.collapsible` 时标题行变成 ▸/▾，收起后只留标题 + 值摘要；
 *   `ui.collapsed: true` 决定初始是收起的（质量词这种"填一次就不动"的长文本用得上）
 *
 * 控件本身的渲染见 FieldControl.vue。
 */
import { computed, reactive } from 'vue';
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
  /** 所属的 `ui.row` 名；`single` 项为 undefined。种子行需要单独排版，靠它辨认 */
  row?: string;
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
      items.push({ kind: 'row', inputs: [input], row });
    } else {
      items[at]!.inputs.push(input);
    }
  }
  return items;
});

const allKeys = computed(() => (props.inputs ?? []).map((i) => i.key));

/**
 * 折叠状态。只记"用户手动切过的"，没切过的按模板的 `ui.collapsed` 走
 * —— 不做初始化快照，因为模板随时可能换（换完新字段自然回到模板默认值）。
 */
const foldState = reactive<Record<string, boolean>>({});

function foldable(input: TemplateInput): boolean {
  return input.ui?.collapsible === true;
}

function isCollapsed(input: TemplateInput): boolean {
  return foldState[input.key] ?? input.ui?.collapsed === true;
}

function toggleFold(input: TemplateInput): void {
  foldState[input.key] = !isCollapsed(input);
}

/** 收起时的值摘要：至少让人知道里面不是空的（长提示词截断） */
function collapsedValue(input: TemplateInput): string {
  const v = props.values[input.key];
  const flat = (Array.isArray(v) ? v.join('、') : v === undefined || v === null ? '' : String(v))
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '（空）';
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

/** 归一化 ui.preset：字符串 = kind，目标为自身；对象可取显式 targets */
function presetSpec(input: TemplateInput): { kind: string; targets: string[] } | null {
  const p = input.ui?.preset;
  if (!p) return null;
  if (typeof p === 'string') return { kind: p, targets: [input.key] };
  return { kind: p.kind, targets: p.targets ?? [input.key] };
}

/** 行内任一字段声明了 preset 就用它（一行只渲染一个切换器） */
function rowPresetSpec(item: LayoutItem): { kind: string; targets: string[] } | null {
  for (const input of item.inputs) {
    const spec = presetSpec(input);
    if (spec) return spec;
  }
  return null;
}

/**
 * 切换器挂在这一行的哪一格：最右那一格。
 *
 * 挂到声明它的那一格（宽）会让按钮落在宽、高中间 —— 看着像"高的东西"；
 * 而挂整行最右，就和单字段的预设一样贴右边，也和输入框不抢宽度。
 */
function isRowPresetHost(item: LayoutItem, input: TemplateInput): boolean {
  return input === item.inputs[item.inputs.length - 1] && rowPresetSpec(item) !== null;
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
          <!-- 可折叠：整行可点，收起时标题后面跟一段值摘要 -->
          <button
            v-if="foldable(item.inputs[0]!)"
            type="button"
            class="field-label fold-toggle"
            :aria-expanded="!isCollapsed(item.inputs[0]!)"
            :title="isCollapsed(item.inputs[0]!) ? '展开' : '收起'"
            @click="toggleFold(item.inputs[0]!)"
          >
            <span class="caret">{{ isCollapsed(item.inputs[0]!) ? '▸' : '▾' }}</span>
            <span class="fold-label">{{ item.inputs[0]!.label }}</span>
            <span v-if="item.inputs[0]!.required" class="req">*</span>
            <span v-if="isCollapsed(item.inputs[0]!)" class="folded-value">
              {{ collapsedValue(item.inputs[0]!) }}
            </span>
          </button>
          <label v-else class="field-label">
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
        <template v-if="!isCollapsed(item.inputs[0]!)">
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
        </template>
      </div>

      <!-- 同行分组 -->
      <div v-else class="row-group">
        <!--
          种子行：独占一行，种子占满左侧、开关靠右 —— 开关是"种子的模式"而不是同级字段，
          并排等宽会看不出主从。这一行也刻意不渲染 description：说明文字挤在这里
          只会把"随机"这个开关的含义搅浑。
        -->
        <div v-if="item.row === 'seed'" class="row seed-row">
          <div class="row-field seed-field">
            <label class="field-label">
              {{ item.inputs.find((i) => i.type === 'seed')?.label }}
            </label>
            <FieldControl
              v-for="input in item.inputs.filter((i) => i.type === 'seed')"
              :key="input.key"
              :input="input"
              :value="props.values[input.key]"
              :models="props.models"
              :random-seed="props.values.randomSeed === true"
              :disabled="props.disabled"
              @update="onUpdate"
            />
          </div>
          <div
            v-for="input in item.inputs.filter((i) => i.type !== 'seed')"
            :key="input.key"
            class="seed-toggle"
          >
            <span class="seed-toggle-label">{{ input.label }}</span>
            <FieldControl
              :input="input"
              :value="props.values[input.key]"
              :models="props.models"
              :disabled="props.disabled"
              @update="onUpdate"
            />
          </div>
        </div>

        <div v-else class="row">
          <template v-for="input in item.inputs" :key="input.key">
            <div class="row-field">
              <!-- 预设写在标签行：标签行本来就空着一大片，放这里才不用跟输入框抢宽度 -->
              <div class="field-head">
                <label class="field-label">
                  {{ input.label }}
                  <span v-if="input.required" class="req">*</span>
                </label>
                <div v-if="isRowPresetHost(item, input)" class="row-pick">
                  <PresetPicker
                    :kind="rowPresetSpec(item)!.kind"
                    :targets="rowPresetSpec(item)!.targets"
                    :values="props.values"
                    :disabled="props.disabled"
                    @apply="onApplyPreset"
                  />
                </div>
              </div>
              <FieldControl
                :input="input"
                :value="props.values[input.key]"
                :models="props.models"
                :random-seed="props.values.randomSeed === true"
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
/* 可折叠字段的标题行：把 button 的默认外观去掉，字号/粗细/颜色沿用 .field-label */
.field-label.fold-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 0;
  padding: 0;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.field-label.fold-toggle:hover .fold-label {
  color: #e2e8f0;
}
.caret {
  flex: 0 0 auto;
  color: #93c5fd;
  font-size: 11px;
  line-height: 1;
}
/* 两个 span 都是 flex 子项：不放开 min-width 的话长文本会把标题行顶宽 */
.fold-label,
.folded-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folded-value {
  flex: 0 1 auto;
  font-weight: 400;
  color: #64748b;
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
/* 同一行里每个字段的标签行必须一样高：预设按钮比标签高 ~5px，只让带预设的那一格
   变高的话，行是顶端对齐，另一个字段的输入框就会高 5px，两个输入框对不齐。 */
.row-field .field-head {
  min-height: 24px;
}
.row-pick {
  flex: 0 0 auto;
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
/* 种子行：种子占满左侧，开关贴右。不换行 —— 换行会让开关漂到种子下面，主从关系又糊了 */
.seed-row {
  flex-wrap: nowrap;
  align-items: flex-end;
}
.seed-field {
  /* 吃掉所有剩余宽度，把开关推到最右 */
  flex: 1 1 auto;
}
.seed-toggle {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.seed-toggle-label {
  font-size: 12px;
  color: #94a3b8;
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
