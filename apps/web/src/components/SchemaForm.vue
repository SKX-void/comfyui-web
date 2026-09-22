<script setup lang="ts">
import type { PluginSettingField } from '../types';

/**
 * 由 `package.json` 的 `plugin.settings[]` 驱动的表单。
 *
 * 为什么用这份自描述元数据而不是 schemastery 推断：
 * 元数据是**静态 JSON**，插件模块导入失败时设置页照样能把它渲染出来 ——
 * 坏插件恰恰是最需要改配置的场景。
 */
const props = defineProps<{
  fields: PluginSettingField[];
  modelValue: Record<string, unknown>;
}>();

const emit = defineEmits<{ 'update:modelValue': [Record<string, unknown>] }>();

/** 与后端约定的脱敏占位：原值回传它是"保持不变"的意思 */
const MASK = '••••••';

function current(field: PluginSettingField): unknown {
  const value = props.modelValue[field.key];
  if (value !== undefined) return value;
  // 声明了 fallback 的字段：**留空本身有意义**（= 跟随宿主统一设置），所以不拿
  // manifest 的 default 去预填 —— 否则用户一保存就把它固化成了"自定"。
  // 内置默认值仍然会以 placeholder 的形式显示（见模板里的 :placeholder）。
  if (field.fallback !== undefined) return field.type === 'boolean' ? false : '';
  return field.default ?? (field.type === 'boolean' ? false : '');
}

function isMasked(field: PluginSettingField): boolean {
  return field.secret === true && props.modelValue[field.key] === MASK;
}

function update(field: PluginSettingField, value: unknown): void {
  emit('update:modelValue', { ...props.modelValue, [field.key]: value });
}

function onText(field: PluginSettingField, event: Event): void {
  update(field, (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
}

function onNumber(field: PluginSettingField, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  update(field, raw === '' ? undefined : Number(raw));
}

function onCheckbox(field: PluginSettingField, event: Event): void {
  update(field, (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="schema-form">
    <div v-for="field in fields" :key="field.key" class="field">
      <label :for="`f-${field.key}`">
        {{ field.label ?? field.key }}
        <code class="key">{{ field.key }}</code>
      </label>

      <template v-if="field.type === 'boolean'">
        <input
          :id="`f-${field.key}`"
          type="checkbox"
          :checked="current(field) === true"
          @change="onCheckbox(field, $event)"
        />
      </template>

      <template v-else-if="field.type === 'select'">
        <select
          :id="`f-${field.key}`"
          :value="String(current(field) ?? '')"
          @change="onText(field, $event)"
        >
          <option v-for="option in field.options ?? []" :key="option" :value="option">
            {{ option }}
          </option>
        </select>
      </template>

      <template v-else-if="field.type === 'number'">
        <input
          :id="`f-${field.key}`"
          type="number"
          :value="current(field)"
          :min="field.min"
          :max="field.max"
          :step="field.step ?? 1"
          @input="onNumber(field, $event)"
        />
      </template>

      <template v-else-if="field.type === 'textarea'">
        <textarea
          :id="`f-${field.key}`"
          rows="4"
          :value="String(current(field) ?? '')"
          @input="onText(field, $event)"
        />
      </template>

      <template v-else>
        <input
          :id="`f-${field.key}`"
          :type="field.secret === true ? 'password' : 'text'"
          :value="isMasked(field) ? '' : current(field)"
          :placeholder="isMasked(field) ? '（已设置，留空表示不改）' : String(field.default ?? '')"
          @input="onText(field, $event)"
        />
      </template>

      <p v-if="field.description" class="hint">{{ field.description }}</p>
    </div>

    <p v-if="fields.length === 0" class="muted">这个插件没有声明可配置项。</p>
  </div>
</template>
