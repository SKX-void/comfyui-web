<script setup lang="ts">
/**
 * LoRA 选择器：**纯目录浏览**。
 *
 * 设计约束（按需求）：
 * - 每层只显示**当前目录直属**的 LoRA，不递归子目录
 * - 子目录作为可进入的文件夹逐层导航
 * - 不提供搜索
 *
 * 数据来自本服务适配层（/api/loras/browse）。之所以不让前端直接打 WeiLin：
 * WeiLin 的 `get_lora_list` 是 41MB，服务端已缓存并按层切片。
 *
 * 触发词：节点已换成 WeiLin Lora堆（`WeiLinPromptUIOnlyLoraStack`），它**不注入**任何触发词；
 * 词由本插件在提交时拼进质量词之前。这里展示/编辑的是那张覆盖表
 * （`<space>/triggers.json`），解析预览走服务端的同一个 resolver，
 * 所以"看到的"就是"注入的"（plugins/anima-plus/docs/weilin.md §5.3）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { LoraFolderEntry, LoraListItem, ResolvedTriggerWord } from '@comfyui-web/shared';
import { api, apiUrl } from '@/api';
import { deepClone } from '@/clone';

export interface LoraValue {
  name: string;
  lora?: string;
  weight: number;
  /** 缺省由后端补 1（前端不再暴露该权重，用户始终用默认值） */
  clipWeight?: number;
  /** 同上 */
  triggerWeight?: number;
  loraWorks?: string;
  hidden?: boolean;
}

const props = defineProps<{
  modelValue: LoraValue[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [LoraValue[]] }>();

const selected = ref<LoraValue[]>([]);
const lastEmitted = ref('');

function sync(value: LoraValue[]): void {
  if (JSON.stringify(value) === lastEmitted.value) return;
  selected.value = deepClone(value ?? []);
}
sync(props.modelValue);
// 外部换值（载入预设等）后重算预览。不能直接写进 sync()：它在 setup 期就被调用了一次，
// 那时下面的触发词状态还没初始化（TDZ）。
watch(
  () => props.modelValue,
  (value) => {
    sync(value);
    void refreshResolved();
  },
);

function commit(): void {
  lastEmitted.value = JSON.stringify(selected.value);
  emit('update:modelValue', deepClone(selected.value));
}

function add(item: LoraListItem): void {
  if (selected.value.some((l) => l.name === item.name)) return;
  // 只带需要的字段：CLIP 权重与触发词权重固定为 1，由后端补齐
  selected.value.push({
    name: item.name,
    lora: item.lora,
    weight: 0.9,
  });
  commit();
  void refreshResolved();
}
function remove(i: number): void {
  selected.value.splice(i, 1);
  commit();
  void refreshResolved();
}
/** 权重显示成两位小数：滑动条没有刻度，值必须看得见 */
function weightText(w: number): string {
  return (Number.isFinite(w) ? w : 0).toFixed(2);
}
function setWeight(i: number, e: Event): void {
  const t = selected.value[i];
  if (!t) return;
  const v = Number((e.target as HTMLInputElement).value);
  t.weight = Number.isNaN(v) ? 0 : v;
  commit();
}

// --- 目录浏览 ---
const currentPath = ref('');
const breadcrumbs = ref<Array<{ name: string; path: string }>>([{ name: '全部', path: '' }]);
const folders = ref<LoraFolderEntry[]>([]);
const items = ref<LoraListItem[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function open(path: string): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const r = await api.browseLoras(path);
    currentPath.value = r.path;
    breadcrumbs.value = r.breadcrumbs;
    folders.value = r.folders;
    items.value = r.items;
  } catch (err) {
    loadError.value = (err as Error).message;
    folders.value = [];
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refreshResolved();
  void open('');
});

// --- 缩略图 ---
/**
 * 预览图走服务端缩略图端点：WeiLin 原图是 1~5MB，列表里直接加载不可行。
 *
 * 卡片用 3:4 竖版（LoRA 预览图多为竖构图，方形裁剪会丢画面）。
 * 尺寸按 2× 屏幕取，保证高分屏下清晰。
 * 无预览图的 LoRA 返回 204，浏览器触发 error → 显示占位块。
 */
function thumbUrl(file: string | undefined, w: number, h?: number): string {
  const q = new URLSearchParams({ file: file ?? '', w: String(w) });
  if (h !== undefined) q.set('h', String(h));
  return apiUrl(`/api/loras/thumb?${q.toString()}`);
}
const thumbFailed = ref<Record<string, boolean>>({});
function onThumbError(file: string): void {
  thumbFailed.value[file] = true;
}
// --- 触发词（三态表 + 服务端解析预览） ---
/**
 * 每个 LoRA 三态：用默认词 / 自定义词 / 关默认且留空（不注入）。
 *
 * 解析**不在前端实现** —— 交给 /api/triggers/resolve（与提交同一个 resolver），
 * 否则界面显示迟早和真正注入的词漂移，那正是换掉全能节点前的老问题。
 * 服务端返回的明细里三态、默认词、最终词都齐了，这里只负责渲染与提交。
 */
const states = ref<Record<string, ResolvedTriggerWord>>({});
/** 正在保存的 LoRA 名（防重复提交 + 置灰） */
const saving = ref<string | null>(null);
const saveError = ref<{ name: string; message: string } | null>(null);

function stateOf(name: string): ResolvedTriggerWord | undefined {
  return states.value[name];
}
/** 第 1 行：WeiLin 标签库给的默认词（可能为空） */
function defaultWordOf(name: string): string {
  return stateOf(name)?.defaultWord ?? '';
}
/** 第 1 行的开关 */
function useDefaultOf(name: string): boolean {
  return stateOf(name)?.useDefault ?? true;
}
/** 第 2 行的编辑框值 */
function customOf(name: string): string {
  return stateOf(name)?.custom ?? '';
}
/** 第 3 行：这次实际会注入的词 */
function finalWordOf(name: string): string {
  return stateOf(name)?.word ?? '';
}
function sourceLabel(name: string): string {
  const s = stateOf(name);
  if (!s) return '';
  if (s.source === 'override') return '自定义';
  if (s.source === 'weilin') return 'WeiLin 默认';
  return s.useDefault ? '无默认词' : '不注入';
}
function rowDisabled(name: string): boolean {
  return props.disabled === true || saving.value === name;
}

/** 解析预览（与提交同源）。失败时清空，宁可显示不出也不假装知道 */
async function refreshResolved(): Promise<void> {
  if (selected.value.length === 0) {
    states.value = {};
    return;
  }
  try {
    const { details } = await api.resolveTriggers(selected.value);
    states.value = Object.fromEntries(details.map((d) => [d.name, d]));
  } catch {
    states.value = {};
  }
}

/**
 * 落盘：开关与编辑框都**即时保存**（没有"保存"按钮），
 * 编辑框走 `change`（失焦/回车）而不是每次按键，免得逐字符刷文件。
 */
async function saveState(name: string, useDefault: boolean, word: string): Promise<void> {
  saving.value = name;
  saveError.value = null;
  try {
    await api.setTriggerWord(name, useDefault, word.trim());
    await refreshResolved();
  } catch (err) {
    saveError.value = { name, message: (err as Error).message };
  } finally {
    saving.value = null;
  }
}

function onToggleDefault(name: string, e: Event): void {
  const useDefault = (e.target as HTMLInputElement).checked;
  // 关掉开关就立刻落盘：此时若没填词，服务端记成"不注入"（第三态）
  void saveState(name, useDefault, useDefault ? '' : customOf(name));
}
function onCustomChange(name: string, e: Event): void {
  void saveState(name, false, (e.target as HTMLInputElement).value);
}

// --- 文件管理器式的导航辅助 ---
/** 上一级目录；根目录时为 null */

const parentPath = computed(() => {
  const segs = currentPath.value ? currentPath.value.split('\\') : [];
  if (segs.length === 0) return null;
  return segs.slice(0, -1).join('\\');
});

/** 真·空目录：既没有子文件夹也没有 LoRA 文件 */
const isTrulyEmpty = computed(
  () => !loading.value && !loadError.value && folders.value.length === 0 && items.value.length === 0,
);

/** 只是没有文件，但有可进入的文件夹 */
const foldersOnly = computed(
  () => !loading.value && !loadError.value && folders.value.length > 0 && items.value.length === 0,
);
</script>

<template>
  <div class="lorasel">
    <!-- 已选 -->
    <div v-if="selected.length === 0" class="hint">尚未选择 LoRA（可留空）</div>
    <div v-for="(l, i) in selected" :key="l.name" class="selected-row">
      <div class="sel-head">
        <span class="sel-name" :title="l.name">{{ l.name.split('\\').pop() }}</span>
        <span class="sel-path">{{ l.name.split('\\').slice(0, -1).join('\\') }}</span>
        <button type="button" class="btn ghost" :disabled="props.disabled" @click="remove(i)">
          移除
        </button>
      </div>

      <div class="sel-body">
        <div class="preview">
          <img
            v-if="l.lora && !thumbFailed[l.lora]"
            :src="thumbUrl(l.lora, 120, 160)"
            class="thumb"
            alt=""
            @error="onThumbError(l.lora!)"
          />
          <div v-else class="thumb placeholder">无预览</div>
        </div>

        <div class="sel-fields">
          <label class="fld fld-range">
            <span>模型权重 <b class="num-val">{{ weightText(l.weight) }}</b></span>
            <input
              class="control range"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="l.weight"
              :disabled="props.disabled"
              @input="setWeight(i, $event)"
            />
          </label>
        </div>

        <!-- 触发词三行：默认（含开关）→ 自定义（可编辑）→ 最终注入词 -->
        <div class="triggers">
          <div class="tr-row">
            <span class="tr-label">默认触发词</span>
            <span v-if="defaultWordOf(l.name)" class="tr-text">{{ defaultWordOf(l.name) }}</span>
            <span v-else class="tr-text muted">无</span>
            <label class="tr-switch" title="关掉后使用下面的自定义词；自定义词留空则不注入">
              <input
                type="checkbox"
                :checked="useDefaultOf(l.name)"
                :disabled="rowDisabled(l.name)"
                @change="onToggleDefault(l.name, $event)"
              />
              <span>使用默认</span>
            </label>
          </div>

          <div class="tr-row">
            <span class="tr-label">自定义注入</span>
            <input
              class="control tr-input"
              type="text"
              :value="customOf(l.name)"
              :disabled="rowDisabled(l.name) || useDefaultOf(l.name)"
              placeholder="留空 = 不注入"
              @change="onCustomChange(l.name, $event)"
            />
          </div>

          <div class="tr-row">
            <span class="tr-label">最终注入词</span>
            <span v-if="finalWordOf(l.name)" class="tr-text final">{{ finalWordOf(l.name) }}</span>
            <span v-else class="tr-text muted">不注入</span>
            <span v-if="sourceLabel(l.name)" class="tr-badge">{{ sourceLabel(l.name) }}</span>
            <span v-if="saving === l.name" class="tr-hint">保存中…</span>
            <span v-if="saveError?.name === l.name" class="tr-err">
              保存失败：{{ saveError.message }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 目录浏览器（文件管理器式） -->
    <div class="fm">
      <!-- 工具栏：位置 + 上一级 -->
      <div class="fm-bar">
        <button
          type="button"
          class="up"
          :disabled="props.disabled || parentPath === null"
          title="返回上一级"
          @click="open(parentPath ?? '')"
        >
          ↑
        </button>
        <div class="crumbs">
          <template v-for="(c, i) in breadcrumbs" :key="c.path">
            <button
              type="button"
              class="crumb"
              :class="{ active: i === breadcrumbs.length - 1 }"
              :disabled="props.disabled || i === breadcrumbs.length - 1"
              @click="open(c.path)"
            >
              {{ c.name }}
            </button>
            <span v-if="i < breadcrumbs.length - 1" class="sep">›</span>
          </template>
        </div>
        <span v-if="loading" class="spin">加载中…</span>
      </div>

      <p v-if="loadError" class="err">
        目录读取失败：{{ loadError }}
        <br />
        <span class="hint">
          若提示"未知接口"，说明后端还是旧版本 —— 刷新页面；仍不行则需重启后端。
        </span>
      </p>

      <!-- 文件夹区（纯文件夹目录也在这里，不会消失） -->
      <template v-if="!loadError">
        <div class="fm-section">
          <div class="fm-head">
            文件夹
            <span class="fm-n">{{ folders.length }}</span>
          </div>
          <div v-if="folders.length" class="fm-list">
            <button
              v-for="f in folders"
              :key="f.path"
              type="button"
              class="fm-row folder"
              :disabled="props.disabled"
              @click="open(f.path)"
            >
              <span class="ico">📁</span>
              <span class="fname">{{ f.name }}</span>
              <span class="meta">{{ f.count > 0 ? `${f.count} 个 LoRA` : '仅含子目录' }}</span>
              <span class="chev">›</span>
            </button>
          </div>
          <p v-else class="fm-empty">没有子文件夹</p>
        </div>

        <!-- LoRA 文件区 -->
        <div class="fm-section">
          <div class="fm-head">
            LoRA 文件
            <span class="fm-n">{{ items.length }}</span>
          </div>
          <div v-if="items.length" class="card-grid">
            <button
              v-for="r in items"
              :key="r.lora"
              type="button"
              class="card"
              :class="{ added: selected.some((s) => s.name === r.name) }"
              :disabled="props.disabled || selected.some((s) => s.name === r.name)"
              :title="r.displayName"
              @click="add(r)"
            >
              <img
                v-if="!thumbFailed[r.lora]"
                :src="thumbUrl(r.lora, 180, 240)"
                class="card-img"
                alt=""
                loading="lazy"
                decoding="async"
                @error="onThumbError(r.lora)"
              />
              <span v-else class="card-img placeholder">🎨</span>
              <span class="card-name">{{ r.displayName }}</span>
              <span v-if="selected.some((s) => s.name === r.name)" class="card-badge">
                已添加
              </span>
            </button>
          </div>
          <p v-else class="fm-empty">
            {{ foldersOnly ? '当前目录只有文件夹，请进入子目录' : '没有 LoRA 文件' }}
          </p>
        </div>

        <p v-if="isTrulyEmpty" class="fm-empty center">该目录是空的</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lorasel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  font-size: 11px;
  color: #64748b;
  margin: 0;
}
.err {
  font-size: 12px;
  color: #fca5a5;
  margin: 0;
}

/* 已选 */
.selected-row {
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 10px;
  background: #0f172a;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sel-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sel-name {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sel-path {
  font-size: 11px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.sel-body {
  display: grid;
  /* 两行：右列上=权重滑动条、右列下=触发词三行；左列图片跨两行吃掉高度差 */
  grid-template-columns: clamp(56px, 15vw, 88px) minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 8px;
}
.preview {
  grid-column: 1;
  grid-row: 1 / span 2;
  min-width: 0;
}
.thumb {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #1f2937;
  background: #111827;
}
.thumb.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #475569;
  font-size: 11px;
}
.sel-fields {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: #94a3b8;
}
.control {
  background: #111827;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 6px 9px;
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
}
/* 权重滑动条：0 ~ 1、步进 0.05（与 anima-example 的 LoRA 强度同一口径）。
   原先是个固定 74px 的数字框；改成滑动条后数值仍显示在标签里，
   否则"滑到哪儿了"看不出来。 */
.fld-range {
  /* 滑动条要横向空间，让它优先占满整行 */
  flex: 1 1 180px;
  min-width: 0;
}
.num-val {
  color: #e2e8f0;
  font-variant-numeric: tabular-nums;
}
.range {
  width: 100%;
  min-width: 0;
  accent-color: #6366f1;
  /* 盖掉 .control 的输入框外观（range 不需要内边距/边框/底色） */
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
}
/* 触发词三行块：在右列、滑动条正下方（图片右侧那块原本浪费掉的空间） */
.triggers {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-top: 1px solid #1e293b;
  padding-top: 5px;
}
.tr-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.tr-label {
  font-size: 11px;
  color: #94a3b8;
  flex: 0 0 62px;
}
.tr-text {
  font-size: 11px;
  color: #93c5fd;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.tr-text.muted {
  color: #64748b;
}
/* 最终注入词是这块的重点：它就是要发出去的东西 */
.tr-text.final {
  color: #6ee7b7;
}
.tr-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
  user-select: none;
}
.tr-switch input {
  accent-color: #6366f1;
  cursor: pointer;
}
.tr-input {
  flex: 1;
  /* 右列本来就窄，别用 min-width 顶出横向滚动 */
  min-width: 0;
  font-size: 11px;
  padding: 2px 6px;
}
/* 来源标记：自定义词要一眼可辨，否则"改了没生效"无从判断 */
.tr-badge {
  font-size: 10px;
  border-radius: 999px;
  padding: 0 6px;
  border: 1px solid #334155;
  color: #94a3b8;
}
.tr-hint {
  font-size: 11px;
  color: #64748b;
}
.tr-err {
  font-size: 11px;
  color: #f87171;
}
.btn {
  border-radius: 6px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 目录浏览器（文件管理器式） */
.fm {
  border: 1px solid #1f2937;
  border-radius: 6px;
  overflow: hidden;
}
.fm-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #111827;
  border-bottom: 1px solid #1f2937;
  flex-wrap: wrap;
}
.up {
  flex: none;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 5px;
  color: #93c5fd;
  font-size: 13px;
  line-height: 1;
  padding: 5px 9px;
  cursor: pointer;
}
.up:hover:not(:disabled) {
  border-color: #6366f1;
}
.up:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  background: none;
  border: none;
  color: #93c5fd;
  font-size: 12px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 4px;
  white-space: nowrap;
}
.crumb:hover:not(:disabled) {
  background: #1e293b;
}
.crumb.active {
  color: #e2e8f0;
  font-weight: 600;
  cursor: default;
}
.sep {
  color: #475569;
  font-size: 12px;
}
.spin {
  margin-left: auto;
  font-size: 11px;
  color: #64748b;
}

.fm-section {
  padding: 6px 0;
}
.fm-section + .fm-section {
  border-top: 1px solid #1f2937;
}
.fm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 6px;
  font-size: 11px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.fm-n {
  background: #1e293b;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10px;
  color: #94a3b8;
}
.fm-list {
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow-y: auto;
}
.fm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  color: #cbd5e1;
  font-size: 12px;
  padding: 6px 10px;
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.fm-row:hover:not(:disabled) {
  background: #1e293b;
}
.fm-row:disabled {
  cursor: default;
}
.fm-row.added {
  opacity: 0.5;
}
.ico {
  flex: none;
  font-size: 13px;
}
.fname,
.iname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fname {
  color: #e2e8f0;
}
.meta {
  flex: none;
  font-size: 11px;
  color: #64748b;
  white-space: nowrap;
}
.meta.ok {
  color: #6ee7b7;
}
.chev {
  flex: none;
  color: #475569;
  font-size: 14px;
}
.fm-empty {
  font-size: 11px;
  color: #64748b;
  margin: 0;
  padding: 4px 10px 8px;
}
.fm-empty.center {
  text-align: center;
  padding: 12px;
}
.fm-row.folder .fname {
  color: #bfdbfe;
}

/* 卡片网格：比行式能放更大的预览图 */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  padding: 8px 10px;
  max-height: 480px;
  overflow-y: auto;
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid #1f2937;
  border-radius: 7px;
  overflow: hidden;
  background: #0f172a;
  cursor: pointer;
  text-align: left;
}
.card:hover:not(:disabled) {
  border-color: #6366f1;
}
.card:disabled {
  cursor: default;
}
.card.added {
  opacity: 0.5;
}
.card-img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  background: #111827;
}
.card-img.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  opacity: 0.35;
}
.card-name {
  padding: 5px 6px 6px;
  font-size: 11px;
  line-height: 1.35;
  color: #cbd5e1;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(16, 185, 129, 0.92);
  color: #052e16;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
