<script setup lang="ts">
/**
 * 预设库面板：像 WeiLin 的「主标签管理器」——命名保存、载入、改名、覆盖、删除。
 * 数据在插件自己的空间里（server.js 的 /presets），刷新、重挂、换浏览器都还在。
 *
 * 与 WeiLin 的区别：**预设保存的是整份结构**（区块标题/颜色/条目/禁用态），
 * 因为"结构只属于工作区"这条设计里，结构就是工作区的全部内容。
 */
import { computed, ref, watch } from 'vue';

import {
  createPreset,
  deletePreset,
  exportPresets,
  getPreset,
  importPresets,
  listPresets,
  updatePreset,
  type PresetSummary,
} from '../api';
import { useImportExport } from '../composables/useImportExport';
import type { Doc } from '../model';

const props = defineProps<{ open: boolean; doc: Doc }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'load', doc: Doc): void }>();

const presets = ref<PresetSummary[]>([]);
const name = ref('');
const busy = ref(false);
const error = ref('');
const hint = ref('');

/** 原生 `<input type=file>` 藏起来，由「导入…」按钮去点它（它长得跟面板不是一套） */
const fileBox = ref<HTMLInputElement | null>(null);

const {
  on: picking,
  busy: transferBusy,
  count: pickedCount,
  isPicked,
  allPicked,
  start: startPick,
  stop: stopPick,
  toggle: togglePick,
  toggleAll: toggleAllPick,
  exportPicked,
  onFilePicked,
} = useImportExport({
  error,
  hint,
  label: '预设库',
  exportFile: exportPresets,
  importFile: async (data) => {
    const done = await importPresets(data);
    await refresh();
    return `已导入 ${done.imported} 份预设${done.skipped > 0 ? `，跳过 ${done.skipped} 条认不出的` : ''}`;
  },
});

/** 全选的对象：当前列表（这里没有筛选，就是全部） */
const presetIds = computed(() => presets.value.map((one) => one.id));

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

async function refresh(): Promise<void> {
  try {
    presets.value = await listPresets();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** 所有动作共用的外壳：统一 busy / 错误 / 提示 */
async function run(action: () => Promise<void>, done: string): Promise<void> {
  busy.value = true;
  error.value = '';
  hint.value = '';
  try {
    await action();
    hint.value = done;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = '';
    hint.value = '';
    name.value = '';
    // 每次打开都退回普通模式：多选是"我现在要挑几条"，不该跟着面板一起记住
    stopPick();
    void refresh();
  },
);

async function saveAs(): Promise<void> {
  const label = name.value.trim();
  if (label === '') {
    error.value = '先给预设起个名字';
    return;
  }
  await run(async () => {
    await createPreset(label, props.doc);
    name.value = '';
    await refresh();
  }, `已保存「${label}」`);
}

async function overwrite(preset: PresetSummary): Promise<void> {
  await run(async () => {
    await updatePreset(preset.id, { doc: props.doc });
    await refresh();
  }, `已覆盖「${preset.name}」`);
}

async function rename(preset: PresetSummary): Promise<void> {
  const next = window.prompt('新的预设名', preset.name);
  if (next === null || next.trim() === '' || next === preset.name) return;
  await run(async () => {
    await updatePreset(preset.id, { name: next.trim() });
    await refresh();
  }, '已改名');
}

async function remove(preset: PresetSummary): Promise<void> {
  if (!window.confirm(`删除预设「${preset.name}」？`)) return;
  await run(async () => {
    await deletePreset(preset.id);
    await refresh();
  }, '已删除');
}

async function load(preset: PresetSummary): Promise<void> {
  await run(async () => {
    const full = await getPreset(preset.id);
    emit('load', full.doc);
  }, `已载入「${preset.name}」`);
}
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>预设库</strong>
        <span class="pe-stat">{{ presets.length }} 份</span>
        <button class="pe-btn" :disabled="busy || transferBusy" @click="fileBox?.click()">导入…</button>
        <button
          class="pe-btn"
          :class="{ on: picking }"
          :disabled="transferBusy"
          title="多选：挑几份一起导出"
          @click="picking ? stopPick() : startPick()"
        >
          {{ picking ? '退出多选' : '多选' }}
        </button>
        <button class="pe-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <input ref="fileBox" class="pe-file" type="file" accept=".json,application/json" @change="onFilePicked" />

      <!-- 多选时把「另存为」收起来：这会儿是在挑要导出的几份，不是要存新的 -->
      <div v-if="picking" class="pe-selbar">
        <label class="pe-pick-all">
          <input type="checkbox" class="pe-pick" :checked="allPicked(presetIds)" @change="toggleAllPick(presetIds)" />
          <span>全选</span>
        </label>
        <span class="pe-sel-count">已选 {{ pickedCount }} / {{ presets.length }}</span>
        <button class="pe-btn" :disabled="pickedCount === 0 || transferBusy" @click="exportPicked">导出选中</button>
        <button class="pe-btn" :disabled="transferBusy" @click="stopPick">取消</button>
      </div>
      <div v-else class="pe-save-row">
        <input v-model="name" class="pe-input" placeholder="预设名（另存为新预设）" @keydown.enter="saveAs" />
        <button class="pe-btn" :disabled="busy" @click="saveAs">另存为</button>
      </div>

      <p v-if="error !== ''" class="pe-error">{{ error }}</p>
      <p v-else-if="hint !== ''" class="pe-hint">{{ hint }}</p>

      <ul class="pe-list">
        <li
          v-for="preset in presets"
          :key="preset.id"
          class="pe-item"
          :class="{ 'pe-item-picking': picking }"
          @click="picking && togglePick(preset.id)"
        >
          <!-- 多选：勾在行首，点行上哪儿都算（手机上 18px 的方框点不准） -->
          <input
            v-if="picking"
            class="pe-pick"
            type="checkbox"
            :checked="isPicked(preset.id)"
            :aria-label="`选择「${preset.name}」`"
            @click.stop
            @change="togglePick(preset.id)"
          />
          <div class="pe-item-main">
            <span class="pe-item-name">{{ preset.name }}</span>
            <span class="pe-item-meta">{{ preset.blockCount }} 区块 · {{ preset.itemCount }} 条目 · {{ formatTime(preset.updatedAt) }}</span>
          </div>
          <!-- 多选时行上只留勾：这会儿点「删除」是手滑，不是意图 -->
          <div v-if="!picking" class="pe-item-actions">
            <button class="pe-btn" :disabled="busy" @click="load(preset)">载入</button>
            <button class="pe-btn" :disabled="busy" @click="overwrite(preset)">覆盖</button>
            <button class="pe-btn" :disabled="busy" @click="rename(preset)">改名</button>
            <button class="pe-btn pe-btn-danger" :disabled="busy" @click="remove(preset)">删除</button>
          </div>
        </li>
        <li v-if="presets.length === 0" class="pe-empty">还没有预设。给当前工作区起个名字，点「另存为」。</li>
      </ul>
    </div>
  </div>
</template>

<style scoped src="./preset-panel.css"></style>
