<script setup lang="ts">
import { SIZE_PRESETS } from '../composables/useForm';
import { useJobContext } from '../composables/useJob';

const { form, limits } = useJobContext();
</script>

<template>
  <div class="field">
    <span>尺寸 <span class="muted">（{{ limits.minSide }}~{{ limits.maxSide }}）</span></span>
    <div class="row">
      <input v-model.number="form.width" type="number" :min="limits.minSide" :max="limits.maxSide" step="8" />
      <span class="times">×</span>
      <input v-model.number="form.height" type="number" :min="limits.minSide" :max="limits.maxSide" step="8" />
      <label class="inline">
        批量
        <input v-model.number="form.batch" type="number" min="1" max="8" class="tiny" />
      </label>
    </div>
    <div class="presets">
      <button v-for="p in SIZE_PRESETS" :key="p.label" type="button" @click="form.width = p.width; form.height = p.height">
        {{ p.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.field {
  display: block;
  min-width: 0;
  margin-bottom: 10px;
}
.field > span {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #94a3b8;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 弹性子项默认 min-width:auto —— 数字输入框的固有宽度会把这一行撑破 */
.row > * {
  min-width: 0;
}
.times {
  color: #64748b;
}
.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}
.tiny {
  width: 56px;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.presets button {
  font-size: 12px;
  padding: 3px 8px;
}
.muted {
  color: #94a3b8;
  font-size: 12px;
}
</style>
