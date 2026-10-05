<script setup lang="ts">
/**
 * 通用下拉选择器（模型选择 / 静态枚举都走它）。
 *
 * 为什么不用原生 `<select>`：下拉面板由系统渲染，无法美化（移动端尤其粗糙），
 * 且长选项名会被截断、无法搜索。
 *
 * 选项是 `string[]`：
 * - 模型名形如 `Anima\0.26.6.17.手办.xxx.safetensors` → 自动按目录分组、显示末级名
 * - 扁平值（如 `WEBP` / `PNG`）→ 无目录，单个分组，组标题自动隐藏
 *
 * 键盘：↑↓ 移动、Enter 选中、Esc 关闭；点外部关闭。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

const open = ref(false);
const query = ref('');
const activeIndex = ref(-1);
const rootEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);

/** 末级文件名（去掉目录部分与扩展名） */
function baseName(path: string): string {
  const seg = path.split('\\').pop() ?? path;
  return seg.replace(/\.safetensors$/i, '');
}
/** 所在目录 */
function folderOf(path: string): string {
  const parts = path.split('\\');
  parts.pop();
  return parts.join('\\');
}
/** 分组键：目录的第一段 */
function groupOf(path: string): string {
  const f = folderOf(path);
  return f.split('\\')[0] || '(根目录)';
}

const selectedLabel = computed(() =>
  props.modelValue ? baseName(props.modelValue) : '',
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter(
    (m) => m.toLowerCase().includes(q) || baseName(m).toLowerCase().includes(q),
  );
});

/** 按目录分组，组内按名称排序 */
const grouped = computed(() => {
  const map = new Map<string, string[]>();
  for (const m of filtered.value) {
    const g = groupOf(m);
    const list = map.get(g);
    if (list) list.push(m);
    else map.set(g, [m]);
  }
  return [...map.entries()]
    .map(([name, items]) => ({
      name,
      // 组内按末级名排序，便于查找
      items: items.sort((a, b) => baseName(a).localeCompare(baseName(b), 'zh')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
});

/** 键盘导航用的扁平顺序，与渲染顺序一致 */
const flat = computed(() => grouped.value.flatMap((g) => g.items));

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

watch(open, (v) => {
  if (v) {
    query.value = '';
    // 打开时定位到当前选中项
    const i = flat.value.indexOf(props.modelValue);
    activeIndex.value = i >= 0 ? i : flat.value.length > 0 ? 0 : -1;
    void nextTick(() => {
      searchEl.value?.focus();
      scrollActiveIntoView();
    });
  }
});

// 过滤结果变化时重置高亮，避免指到不存在的项
watch(filtered, () => {
  activeIndex.value = flat.value.length > 0 ? 0 : -1;
});

function pick(model: string): void {
  emit('update:modelValue', model);
  open.value = false;
}

function clear(e: Event): void {
  e.stopPropagation();
  emit('update:modelValue', '');
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const el = rootEl.value?.querySelector<HTMLElement>('.opt.active');
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function move(delta: number): void {
  const n = flat.value.length;
  if (n === 0) return;
  activeIndex.value = (activeIndex.value + delta + n) % n;
  scrollActiveIntoView();
}

function onKeydown(e: KeyboardEvent): void {
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      open.value = true;
    }
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      move(-1);
      break;
    case 'Enter': {
      e.preventDefault();
      const m = flat.value[activeIndex.value];
      if (m) pick(m);
      break;
    }
    case 'Escape':
      e.preventDefault();
      open.value = false;
      break;
    case 'Tab':
      open.value = false;
      break;
  }
}

function onDocMouseDown(e: MouseEvent): void {
  if (!open.value) return;
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown));
</script>

<template>
  <div ref="rootEl" class="msel" :class="{ disabled: props.disabled, open }">
    <!-- 收起态：当前选择 -->
    <button
      type="button"
      class="trigger"
      :disabled="props.disabled"
      :title="props.modelValue || ''"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="tr-main">
        <span v-if="props.modelValue" class="tr-name">{{ selectedLabel }}</span>
        <span v-else class="tr-empty">{{ props.placeholder ?? '（请选择）' }}</span>
      </span>
      <span v-if="props.modelValue && !props.disabled" class="tr-clear" title="清除" @click="clear">
        ×
      </span>
      <span class="tr-caret">▾</span>
    </button>

    <!-- 展开态 -->
    <div v-if="open" class="panel">
      <div class="panel-search">
        <input
          ref="searchEl"
          v-model="query"
          class="search"
          type="text"
          placeholder="搜索模型名…"
          @keydown="onKeydown"
        />
        <span class="count">{{ filtered.length }} / {{ props.options.length }}</span>
      </div>

      <div v-if="flat.length === 0" class="empty">
        {{ props.options.length === 0 ? '没有可用模型' : '没有匹配的模型' }}
      </div>

      <div v-else class="list">
        <template v-for="g in grouped" :key="g.name">
          <!-- 只有一个分组时组标题是冗余的 -->
          <div v-if="grouped.length > 1" class="group">{{ g.name }}</div>
          <button
            v-for="m in g.items"
            :key="m"
            type="button"
            class="opt"
            :class="{ active: flat[activeIndex] === m, current: m === props.modelValue }"
            :title="m"
            @click="pick(m)"
            @mouseenter="activeIndex = flat.indexOf(m)"
          >
            <span class="opt-check">{{ m === props.modelValue ? '✓' : '' }}</span>
            <span class="opt-body">
              <span class="opt-name">{{ baseName(m) }}</span>
              <span v-if="folderOf(m)" class="opt-folder">{{ folderOf(m) }}</span>
            </span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msel {
  position: relative;
  width: 100%;
}
.msel.disabled {
  opacity: 0.5;
}

/* 收起态 */
.trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}
.trigger:hover:not(:disabled) {
  border-color: #475569;
}
.msel.open .trigger {
  border-color: #6366f1;
}
.trigger:disabled {
  cursor: not-allowed;
}
.tr-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tr-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tr-empty {
  color: #64748b;
}
.tr-clear {
  flex: none;
  color: #64748b;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
}
.tr-clear:hover {
  color: #fca5a5;
}
.tr-caret {
  flex: none;
  color: #64748b;
  font-size: 11px;
}

/* 展开面板 */
.panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.panel-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-bottom: 1px solid #1f2937;
}
.search {
  flex: 1;
  min-width: 0;
  background: #111827;
  border: 1px solid #334155;
  border-radius: 5px;
  color: #e2e8f0;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
}
.search:focus {
  outline: none;
  border-color: #6366f1;
}
.count {
  flex: none;
  font-size: 10px;
  color: #64748b;
}
.empty {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: #64748b;
}
.list {
  max-height: 300px;
  overflow-y: auto;
  padding-bottom: 4px;
}
.group {
  position: sticky;
  top: 0;
  background: #0b1220;
  padding: 4px 9px;
  font-size: 10px;
  color: #64748b;
  letter-spacing: 0.03em;
  border-bottom: 1px solid #1f2937;
}
.opt {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  color: #cbd5e1;
  padding: 6px 9px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}
.opt.active {
  background: #1e293b;
}
.opt.current {
  color: #a5b4fc;
}
.opt-check {
  flex: none;
  width: 12px;
  color: #6ee7b7;
  font-size: 11px;
}
.opt-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.opt-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.opt-folder {
  font-size: 10px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
