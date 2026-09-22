<script setup lang="ts">
/**
 * 主提示词输入 + 标签辅助。
 *
 * 设计取舍：**textarea 是唯一的事实来源**，直接绑定模板值，所见即所发。
 * 标签补全/分组浏览只是"往 textarea 里追加文本"的辅助工具，
 * 不引入 chips 这类中间态——避免"打了字没回车就没提交"的陷阱。
 *
 * 标签数据来自本服务的 WeiLin 适配层（/api/tags/*）。
 * 数据源不可用时自动退化为纯文本输入，不影响出图。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { TagGroupItem, TagItem } from '@comfyui-web/shared';
import { api } from '@/api';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

/** textarea 直接写入模板值 */
function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}

/** 追加一个标签到末尾（去重） */
function insert(text: string): void {
  const t = text.trim();
  if (!t) return;
  const parts = props.modelValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(t)) parts.push(t);
  emit('update:modelValue', parts.join(', '));
  query.value = '';
  suggestions.value = [];
}

const tagCount = computed(
  () => props.modelValue.split(',').map((s) => s.trim()).filter(Boolean).length,
);

// --- 补全 ---
const query = ref('');
const suggestions = ref<TagItem[]>([]);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(query, (v) => {
  if (timer) clearTimeout(timer);
  const q = v.trim();
  if (q.length < 2) {
    suggestions.value = [];
    return;
  }
  timer = setTimeout(async () => {
    try {
      suggestions.value = (await api.autocompleteTags(q)).items.slice(0, 10);
    } catch {
      suggestions.value = [];
    }
  }, 180);
});

// --- 分组浏览 ---
const groups = ref<TagGroupItem[]>([]);
const groupsError = ref(false);
const openGroup = ref<number | null>(null);
const openSub = ref<number | null>(null);
const groupTags = ref<TagItem[]>([]);
const loadingTags = ref(false);
const browseOpen = ref(false);

onMounted(async () => {
  try {
    groups.value = (await api.listTagGroups()).items;
  } catch {
    groupsError.value = true; // WeiLin 不可用：隐藏分组浏览，纯文本照常可用
  }
});

async function loadGroupTags(groupId: number): Promise<void> {
  loadingTags.value = true;
  try {
    groupTags.value = (await api.listTags({ groupId, pageSize: 200 })).items;
  } catch {
    groupTags.value = [];
  } finally {
    loadingTags.value = false;
  }
}

function toggleGroup(g: TagGroupItem): void {
  if (openGroup.value === g.id) {
    openGroup.value = null;
    openSub.value = null;
    groupTags.value = [];
    return;
  }
  openGroup.value = g.id;
  openSub.value = null;
  void loadGroupTags(g.id);
}

function toggleSub(topId: number, subId: number): void {
  openGroup.value = topId;
  if (openSub.value === subId) {
    openSub.value = null;
    void loadGroupTags(topId);
    return;
  }
  openSub.value = subId;
  void loadGroupTags(subId);
}
</script>

<template>
  <div class="tagsel">
    <!-- 主输入：所见即所发 -->
    <textarea
      class="control prompt"
      :rows="props.rows ?? 5"
      :placeholder="props.placeholder ?? '输入提示词'"
      :disabled="props.disabled"
      :value="props.modelValue"
      @input="onInput"
    />

    <div class="meta">
      <span class="hint">{{ tagCount }} 个标签（逗号分隔）</span>
      <button
        v-if="!groupsError && groups.length"
        type="button"
        class="btn ghost"
        :disabled="props.disabled"
        @click="browseOpen = !browseOpen"
      >
        {{ browseOpen ? '收起标签库' : '从标签库选择' }}
      </button>
    </div>

    <!-- 标签辅助工具 -->
    <div v-if="!groupsError && groups.length" class="tools">
      <div class="query-row">
        <input
          class="control"
          type="text"
          placeholder="搜索标签后回车追加（如 blue hair）…"
          :disabled="props.disabled"
          v-model="query"
          @keydown.enter.prevent="suggestions[0] && insert(suggestions[0].text)"
        />
      </div>

      <div v-if="suggestions.length" class="suggest">
        <button
          v-for="s in suggestions"
          :key="s.text"
          type="button"
          class="suggest-item"
          :disabled="props.disabled"
          @click="insert(s.text)"
        >
          <span>{{ s.text }}</span>
          <span class="tr">{{ s.translate }}</span>
        </button>
      </div>

      <div v-if="browseOpen" class="browse">
        <div class="browse-col">
          <div class="browse-title">分组</div>
          <button
            v-for="g in groups"
            :key="g.id"
            type="button"
            class="group-btn"
            :class="{ active: openGroup === g.id }"
            @click="toggleGroup(g)"
          >
            <span class="dot" :style="{ background: g.color }" />
            {{ g.name }}
            <span class="count">{{ g.tagCount }}</span>
          </button>
        </div>

        <div class="browse-col">
          <div class="browse-title">子组</div>
          <template v-if="openGroup !== null">
            <button
              v-for="s in groups.find((g) => g.id === openGroup)?.subgroups ?? []"
              :key="s.id"
              type="button"
              class="group-btn"
              :class="{ active: openSub === s.id }"
              @click="toggleSub(openGroup!, s.id)"
            >
              {{ s.name }}
              <span class="count">{{ s.tagCount }}</span>
            </button>
          </template>
          <p v-else class="hint">选择左侧分组</p>
        </div>

        <div class="browse-col wide">
          <div class="browse-title">标签（点击追加）</div>
          <div class="tag-grid">
            <button
              v-for="t in groupTags"
              :key="t.id"
              type="button"
              class="tag-btn"
              :disabled="props.disabled"
              @click="insert(t.text)"
            >
              <span>{{ t.text }}</span>
              <span class="tr">{{ t.translate }}</span>
            </button>
            <p v-if="loadingTags" class="hint">加载中…</p>
            <p v-else-if="groupTags.length === 0" class="hint">该分组暂无标签</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tagsel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.control {
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.control:focus {
  outline: none;
  border-color: #6366f1;
}
.prompt {
  resize: vertical;
  line-height: 1.5;
}
.meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hint {
  font-size: 11px;
  color: #64748b;
  margin: 0;
}
.tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.query-row {
  display: flex;
}
.btn {
  border-radius: 6px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.suggest {
  display: flex;
  flex-direction: column;
  border: 1px solid #334155;
  border-radius: 6px;
  overflow: hidden;
  max-height: 220px;
  overflow-y: auto;
}
.suggest-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  background: #0f172a;
  border: none;
  border-bottom: 1px solid #1e293b;
  color: #e2e8f0;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.suggest-item:hover {
  background: #1e293b;
}
.tr {
  color: #94a3b8;
}
.browse {
  display: grid;
  /* minmax(0,…)：两列固定宽 + 1fr 的组合在窄屏上会溢出，给每列一个可收缩的下限 */
  grid-template-columns: minmax(0, 130px) minmax(0, 130px) minmax(0, 1fr);
  gap: 8px;
  border: 1px solid #1f2937;
  border-radius: 6px;
  padding: 8px;
}
.browse-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  max-height: 260px;
  /* 列内长标签不参与"最小宽度"计算，否则会把窄屏撑出横向滚动条 */
  min-width: 0;
}
.browse-col.wide {
  border-left: 1px solid #1f2937;
  padding-left: 8px;
}
.browse-title {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 3px;
  position: sticky;
  top: 0;
  background: #111827;
}
.group-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: #cbd5e1;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.group-btn:hover,
.group-btn.active {
  background: #1e293b;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.count {
  margin-left: auto;
  color: #64748b;
  font-size: 10px;
}
.tag-grid {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tag-btn {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  background: none;
  border: none;
  color: #cbd5e1;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.tag-btn:hover {
  background: #1e293b;
}

/**
 * 窄屏（手机）：浏览面板原本是 130px + 130px + 1fr 三列并排，
 * 光两列固定宽度就 260px，加上间距/内边距已经超过手机内容宽度。
 * 这里改成"分组 | 子组"两列，标签列表另起一行占满整行。
 */
@media (max-width: 640px) {
  .browse {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .browse-col {
    max-height: 160px;
  }
  .browse-col.wide {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid #1f2937;
    padding-left: 0;
    padding-top: 8px;
    max-height: 220px;
  }
}
</style>
