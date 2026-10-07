<script setup lang="ts">
/**
 * 区块库面板：**预设单块**的库（跟「预设库」那份整份文档不是一回事）。
 *
 * 来源是区块表头的「存」—— 点了会把那一块的快照（标题/颜色/风格/条目文本）送到这里，
 * 面板打开并给出"给它起个名字"的输入框（**自动抢焦点**：不抢的话回车存不了、用户会以为点了没反应）。
 *
 * 插入 = **新增一块、追加到最后**（不动任何已有区块）。条目译文不带：库里那份可能已经过期，
 * 插进来按当前词库重新查才对。
 */
import { nextTick, ref, watch } from 'vue';

import {
  createBlockPreset,
  deleteBlockPreset,
  getBlockPreset,
  listBlockPresets,
  renameBlockPreset,
  type BlockPreset,
  type BlockPresetSummary,
} from '../api';
import { MODE_LABEL, type Mode } from '../model';

/** 从区块表头送来的一块快照（要存进库的那个） */
export interface PendingBlock {
  title: string;
  color: string;
  mode: Mode;
  items: string[];
}

const props = defineProps<{ open: boolean; pending: PendingBlock | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'insert', preset: BlockPreset): void; (e: 'cancel-pending'): void }>();

const presets = ref<BlockPresetSummary[]>([]);
const name = ref('');
const busy = false;
const busyId = ref('');
const error = ref('');
const hint = ref('');
const nameBox = ref<HTMLInputElement | null>(null);

async function refresh(): Promise<void> {
  try {
    presets.value = await listBlockPresets();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** 所有动作共用的外壳：统一 busy / 错误 / 提示（跟 PresetPanel 同一套） */
async function run(action: () => Promise<void>, done: string): Promise<void> {
  error.value = '';
  hint.value = '';
  try {
    await action();
    hint.value = done;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/**
 * 打开面板（或又送来一块）→ 重新拉列表；带着块来的话把名字框填上并抢焦点。
 *
 * `flush: 'post'`：默认的 pre 时机里 `nameBox` 还是空的，抢焦点会静默失效
 * （分类改名那个 bug 就是这么来的）。
 */
watch(
  () => [props.open, props.pending] as const,
  ([open, pending]) => {
    if (!open) return;
    error.value = '';
    hint.value = '';
    void refresh();
    if (pending === null) return;
    name.value = pending.title.trim();
    void nextTick(() => nameBox.value?.focus());
  },
  { flush: 'post' },
);

async function save(): Promise<void> {
  const pending = props.pending;
  if (pending === null) return;
  const label = name.value.trim();
  if (label === '') {
    error.value = '先给它起个名字';
    return;
  }
  await run(async () => {
    await createBlockPreset({ name: label, ...pending });
    name.value = '';
    emit('cancel-pending');
    await refresh();
  }, `已存进区块库：「${label}」（${pending.items.length} 条）`);
}

async function insert(preset: BlockPresetSummary): Promise<void> {
  busyId.value = preset.id;
  await run(async () => {
    const full = await getBlockPreset(preset.id);
    emit('insert', full);
  }, `已插入区块「${preset.name}」`);
  busyId.value = '';
}

async function rename(preset: BlockPresetSummary): Promise<void> {
  const next = window.prompt('新的名字', preset.name);
  if (next === null || next.trim() === '' || next.trim() === preset.name) return;
  await run(async () => {
    await renameBlockPreset(preset.id, next.trim());
    await refresh();
  }, '已改名');
}

async function remove(preset: BlockPresetSummary): Promise<void> {
  if (!window.confirm(`删掉区块库里的「${preset.name}」？（只删库里这份，工作区不受影响）`)) return;
  await run(async () => {
    await deleteBlockPreset(preset.id);
    await refresh();
  }, '已删除');
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>区块库</strong>
        <span class="pe-blk-count">{{ presets.length }} 块</span>
        <button class="pe-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <div v-if="pending !== null" class="pe-blk-save">
        <input
          ref="nameBox"
          v-model="name"
          class="pe-input"
          placeholder="给它起个名字（存进区块库）"
          @keydown.enter="save"
          @keydown.esc="emit('cancel-pending')"
        />
        <button class="pe-btn" @click="save">存</button>
        <button class="pe-btn" @click="emit('cancel-pending')">取消</button>
      </div>
      <p v-else class="pe-blk-tip">在区块表头点「存」把一块存进来。</p>

      <p v-if="error !== ''" class="pe-error">{{ error }}</p>
      <p v-else-if="hint !== ''" class="pe-hint">{{ hint }}</p>

      <ul class="pe-list">
        <li v-for="preset in presets" :key="preset.id" class="pe-item">
          <div class="pe-item-main">
            <span class="pe-item-name">
              <span class="pe-blk-color" :style="{ background: preset.color }" />
              {{ preset.name }}
            </span>
            <span class="pe-item-meta">
              {{ MODE_LABEL[preset.mode] }} · {{ preset.itemCount }} 条 · {{ formatTime(preset.updatedAt) }}
            </span>
            <span class="pe-blk-preview">{{ preset.preview.join(' · ') }}</span>
          </div>
          <div class="pe-item-actions">
            <button class="pe-btn" :disabled="busyId !== ''" @click="insert(preset)">插入</button>
            <button class="pe-btn" :disabled="busyId !== ''" @click="rename(preset)">改名</button>
            <button class="pe-btn pe-btn-danger" :disabled="busyId !== ''" @click="remove(preset)">删除</button>
          </div>
        </li>
        <li v-if="presets.length === 0" class="pe-empty">区块库还是空的。</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.pe-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.pe-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(760px, 92vw);
  max-height: 82vh;
  padding: 16px 18px;
  border: 1px solid var(--line, #2c313a);
  border-radius: 12px;
  background: var(--panel, #1b1e24);
}

.pe-panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pe-panel-head strong {
  font-size: 15px;
}

.pe-blk-count {
  color: var(--muted, #8b93a1);
  font-size: 12px;
}

.pe-close {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--muted, #8b93a1);
  font-size: 18px;
  cursor: pointer;
}

.pe-blk-save {
  display: flex;
  gap: 8px;
}

.pe-blk-save .pe-input {
  flex: 1;
}

.pe-blk-tip {
  margin: 0;
  color: var(--muted, #8b93a1);
  font-size: 12px;
}

.pe-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.pe-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line, #2c313a);
  border-radius: 8px;
  background: var(--panel-2, #22262e);
}

.pe-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.pe-item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.pe-item-meta {
  color: var(--muted, #8b93a1);
  font-size: 11px;
}

.pe-blk-color {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.pe-blk-preview {
  overflow: hidden;
  color: var(--muted, #8b93a1);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pe-item-actions {
  display: flex;
  gap: 6px;
}

.pe-empty {
  padding: 10px 4px;
  color: var(--muted, #8b93a1);
  font-size: 12px;
  list-style: none;
}
</style>
