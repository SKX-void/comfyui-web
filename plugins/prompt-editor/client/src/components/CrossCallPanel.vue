<script setup lang="ts">
/**
 * 跨域调用区：把上面的输出当作 anima-plus 的描述提示词，直接向它发起一次出图。
 * 状态与流程在 composables/useCrossCall.ts，这里只管画。
 *
 * 参数基底一律取自对方「最后一次状态」（last-state.json）—— 对方没跑过一次就没有基底，
 * 这里不给猜模板默认值，直接把原因写出来（跨插件依赖是特别允许的，但边界要看得见）。
 */
import { computed, onActivated, onMounted, watch } from 'vue';

import { useCrossCall } from '../composables/useCrossCall';

const props = defineProps<{ text: string }>();

const { targets, selectedId, target, availability, plan, blocked, busy, receipt, error, refresh, run } =
  useCrossCall(() => props.text);

const disabled = computed(() => props.text === '' || blocked.value !== '' || busy.value);
/**
 * 禁用原因**两条一起说**：本插件没内容、和下游没有参数基底是两回事，
 * 首屏两个都成立时只显示一条，人会以为"写了字就能发"。
 */
const hint = computed(() => {
  const reasons: string[] = [];
  if (props.text === '') reasons.push('左边写出内容，这里才有东西可发');
  if (blocked.value !== '') reasons.push(blocked.value);
  return reasons.join('；');
});
const link = computed(() => `/w/${target.value?.id ?? ''}`);

onMounted(refresh);
// 开了常驻（设置页的「切走不卸载」，D26）后 onMounted 不再随切 tab 触发，而下游可能已经被停用/卸载：
// 每次切回来重探一次（三个 GET，很便宜），行为和"切走即卸载"时逐字一致
onActivated(refresh);
watch(selectedId, refresh);
</script>

<template>
  <div class="pe-cross">
    <div class="pe-cross-head">
      <strong>跨域调用</strong>
      <select v-if="targets.length > 1" v-model="selectedId" class="pe-cross-pick">
        <option v-for="one in targets" :key="one.id" :value="one.id">{{ one.label }}</option>
      </select>
      <span v-else class="pe-cross-name">{{ target?.label ?? '没有下游' }}</span>
      <button class="pe-cross-refresh" :disabled="busy" @click="refresh">刷新</button>
    </div>

    <p v-if="availability !== null" class="pe-cross-status" :class="{ 'pe-cross-off': !availability.ok }">
      {{ availability.detail }}
    </p>

    <ul v-if="plan !== null" class="pe-cross-params">
      <li v-for="param in plan.params" :key="param.label">{{ param.label }} {{ param.value }}</li>
    </ul>

    <button class="pe-cross-run" :disabled="disabled" @click="run">
      {{ busy ? '正在调用…' : '把输出发去出图' }}
    </button>
    <p v-if="hint !== ''" class="pe-cross-hint">{{ hint }}</p>

    <p v-if="error !== ''" class="pe-cross-error">{{ error }}</p>
    <p v-if="receipt !== null" class="pe-cross-receipt">
      已加入队列 {{ receipt.jobId }}<template v-if="receipt.queuePosition !== null">（排队第 {{ receipt.queuePosition }} 位）</template
      ><template v-if="receipt.seed !== null"> · 种子 {{ receipt.seed }}</template>
      <a class="pe-cross-link" :href="link">去看进度 →</a>
    </p>
    <p v-if="receipt !== null && receipt.warning !== ''" class="pe-cross-hint">{{ receipt.warning }}</p>
  </div>
</template>

<style scoped>
.pe-cross {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
  padding: 8px 10px;
}

.pe-cross-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pe-cross-name {
  flex: 1;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-cross-pick {
  flex: 1;
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 2px 6px;
}

.pe-cross-refresh,
.pe-cross-run {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 3px 10px;
  cursor: pointer;
}

.pe-cross-refresh {
  font-size: 11px;
}

.pe-cross-run {
  width: 100%;
}

.pe-cross-refresh:disabled,
.pe-cross-run:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pe-cross-status,
.pe-cross-hint,
.pe-cross-error,
.pe-cross-receipt {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}

.pe-cross-status {
  color: var(--muted, #9aa3b2);
}

.pe-cross-off,
.pe-cross-error {
  color: var(--warn, #e0a34a);
}

.pe-cross-params {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-cross-link {
  margin-left: 6px;
  color: var(--accent, #6ea8fe);
}

@media (max-width: 720px) {
  /* 这两个是面板上仅有的动作，手机上一律撑到指头点得准 */
  .pe-cross-refresh,
  .pe-cross-run {
    padding: 10px 12px;
    font-size: 14px;
  }
}
</style>
