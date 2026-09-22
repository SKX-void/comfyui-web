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
 * 注意：触发词由 WeiLin 节点在执行期**自动注入**，此处仅作展示，
 * 写进 loraWorks 也不会改变注入结果（v1-weilin.md §5.3）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { LoraFolderEntry, LoraListItem, LoraMeta } from '@comfyui-web/shared';
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
watch(() => props.modelValue, sync);

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
  void loadMeta(item.lora);
}
function remove(i: number): void {
  selected.value.splice(i, 1);
  commit();
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

onMounted(() => void open(''));

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
const metaCache = ref<Record<string, LoraMeta | 'loading' | 'error'>>({});

async function loadMeta(file: string): Promise<void> {
  if (metaCache.value[file]) return;
  metaCache.value[file] = 'loading';
  try {
    metaCache.value[file] = await api.getLoraMeta(file);
  } catch {
    metaCache.value[file] = 'error';
  }
}

// --- 文件管理器式的导航辅助 ---
/** 上一级目录；根目录时为 null */
/**
 * 已加载到的触发词。未加载 / 加载中 / 无数据都返回空数组 ——
 * 这样整行只在**确实有触发词**时出现，不会出现"加载中"被显示成"未知"的误导。
 */
function triggerWords(file: string | undefined): string[] {
  const m = file ? metaCache.value[file] : undefined;
  if (!m || m === 'loading' || m === 'error') return [];
  return m.triggerWords;
}

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

        <div v-if="triggerWords(l.lora).length" class="triggers">
          <span class="tr-label">触发词：</span>
          <span class="tr-text">{{ triggerWords(l.lora).slice(0, 3).join(', ') }}</span>
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
  grid-template-columns: clamp(56px, 15vw, 88px) minmax(0, 1fr);
  gap: 10px;
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
.triggers {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.tr-label {
  font-size: 11px;
  color: #94a3b8;
}
.tr-text {
  font-size: 11px;
  color: #93c5fd;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
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
