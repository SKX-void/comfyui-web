<script setup lang="ts">
import { useJobContext } from '../composables/useJob';
import SettingsPanel from '../SettingsPanel.vue';
import ModelFields from './ModelFields.vue';
import SizeField from './SizeField.vue';

const {
  form,
  limits,
  options,
  joinedPrompt,
  canSubmit,
  running,
  submit,
  cancel,
  current,
  loadError,
  settingsOpen,
  rollSeed,
} = useJobContext();
</script>

<template>
  <section class="panel form">
    <header class="panel-head">
      <h2>默认Anima</h2>
      <span v-if="options" class="badge">工作流 {{ options.workflow.nodes }} 节点 · {{ options.workflow.file }}</span>
      <!-- 设置：本插件自己持有配置（存进自己的 ctx.space，宿主不代管） -->
      <button
        class="mini"
        type="button"
        style="margin-left: auto"
        title="插件设置（保存在插件自己的空间里）"
        @click="settingsOpen = true"
      >
        设置
      </button>
    </header>

    <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />

    <label class="field">
      <span>描述提示词</span>
      <textarea v-model="form.description" rows="5" placeholder="1girl, solo, blue hair, looking at viewer" />
    </label>

    <details class="field">
      <summary>正向提示词（质量 / 风格）</summary>
      <textarea v-model="form.positive" rows="5" />
    </details>

    <details class="field">
      <summary>负向提示词</summary>
      <textarea v-model="form.negative" rows="5" />
    </details>

    <p v-if="joinedPrompt" class="joined" :title="joinedPrompt">
      <span class="muted">拼给 ComfyUI：</span>{{ joinedPrompt }}
    </p>

    <SizeField />

    <div class="grid3">
      <label class="field">
        <span>步数 <span class="muted">（≤{{ limits.maxSteps }}）</span></span>
        <input v-model.number="form.steps" type="number" :min="limits.minSteps" :max="limits.maxSteps" />
      </label>
      <label class="field">
        <span>CFG</span>
        <input v-model.number="form.cfg" type="number" min="0" max="30" step="0.1" />
      </label>
      <div class="field">
        <span>种子</span>
        <div class="row">
          <input v-model.number="form.seed" type="number" :disabled="form.randomSeed" />
          <button type="button" title="随机" @click="rollSeed">🎲</button>
        </div>
        <label class="inline"><input v-model="form.randomSeed" type="checkbox" /> 每次随机</label>
      </div>
    </div>

    <div class="grid2">
      <label class="field">
        <span>采样器</span>
        <select v-model="form.sampler">
          <option v-for="s in options?.sampler ?? []" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label class="field">
        <span>调度器</span>
        <select v-model="form.scheduler">
          <option v-for="s in options?.scheduler ?? []" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
    </div>

    <div v-if="options?.defaults.hasLoraNode" class="field">
      <span>LoRA · 强度 {{ Number(form.loraStrength).toFixed(2) }}</span>
      <select v-model="form.lora" :title="form.lora">
        <option v-for="l in options?.lora ?? []" :key="l" :value="l">{{ l }}</option>
      </select>
      <input v-model.number="form.loraStrength" type="range" min="0" max="1" step="0.05" class="range" />
    </div>

    <label v-if="options?.defaults.hasRotateNode" class="field">
      <span>旋转</span>
      <select v-model="form.rotation">
        <option v-for="r in options?.rotation ?? []" :key="r" :value="r">{{ r }}</option>
      </select>
    </label>

    <ModelFields />

    <div class="actions">
      <button class="primary" type="button" :disabled="!canSubmit" @click="submit">
        {{ running ? '生成中…' : '开始生成' }}
      </button>
      <button v-if="running" type="button" @click="cancel">打断</button>
      <span v-if="current" class="jobid" :title="current.jobId">{{ current.jobId.slice(0, 8) }}</span>
    </div>

    <p v-if="loadError" class="error">{{ loadError }}</p>
  </section>
</template>

<style scoped>
/* 本组件是 .layout 的网格项，min-width 跟着元素走（父组件的 scoped 样式管不到这里） */
.panel {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 14px 16px 16px;
  min-width: 0;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.badge {
  font-size: 12px;
  color: #94a3b8;
}

.mini {
  font-size: 12px;
  padding: 2px 8px;
  margin-left: auto;
}

.field {
  display: block;
  min-width: 0;
  margin-bottom: 10px;
}
.field > span,
.field > summary {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #94a3b8;
}
.field > summary {
  cursor: pointer;
}

/* 拼接预览：单行截断，悬停看全 */
.joined {
  margin: -2px 0 10px;
  padding: 6px 8px;
  border-left: 2px solid #334155;
  border-radius: 4px;
  background: #0b1220;
  font-size: 12px;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}
.inline input[type='checkbox'] {
  width: auto;
  margin: 0;
}
.range {
  padding: 0;
  margin-top: 6px;
}

/* minmax(0,1fr)：直接用 1fr 时轨道下限是 auto，仍会被最长选项顶开 */
.grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
}
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}
.grid2 > *,
.grid3 > * {
  min-width: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.actions .primary {
  background: #0369a1;
  border-color: #0284c7;
  padding: 8px 18px;
}
.actions .primary:hover:not(:disabled) {
  background: #075985;
}
.jobid {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #64748b;
}

.muted {
  color: #94a3b8;
  font-size: 12px;
}
.error {
  margin: 10px 0 0;
  color: #fca5a5;
  font-size: 13px;
  white-space: pre-wrap;
}
</style>
