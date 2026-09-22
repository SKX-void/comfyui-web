<script setup lang="ts">
/**
 * 预设选择器：触发按钮 + 选择对话框。
 *
 * 对话框列出该类别全部预设，展示**详细内容**（按字段元数据渲染），
 * 由「载入」按钮套用；底部可直接把当前表单值存成新预设。
 *
 * 组件不直接改表单值 —— 用 `apply` 事件把 values 交给父级，
 * 父级再按模板 input 过滤后写入（见 `applyPreset`）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PresetField, PresetKindPayload, PresetRecord } from '@comfyui-web/shared';
import { extractPreset, usePresets } from '@/presets';

const props = defineProps<{
  kind: string;
  /** 保存当前值时，从表单里抽哪些字段 */
  targets: string[];
  /** 当前表单值，用于「保存当前值」 */
  values: Record<string, unknown>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ apply: [values: Record<string, unknown>] }>();

const { state, load, kindOf, save, remove } = usePresets();

const open = ref(false);
const newName = ref('');
const newDesc = ref('');
const busy = ref(false);
const err = ref<string | null>(null);

const payload = computed<PresetKindPayload | undefined>(() => kindOf(props.kind));
const items = computed<PresetRecord[]>(() => payload.value?.items ?? []);
const fields = computed<PresetField[]>(() => payload.value?.fields ?? []);
const title = computed(() => payload.value?.label ?? props.kind);

onMounted(() => void load());

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault();
    open.value = false;
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));

// 打开时清掉上次的残留状态
watch(open, (v) => {
  if (v) {
    err.value = null;
    void load();
  }
});

/** 展示字段值：文本过长时截断（完整内容在 title 里） */
function display(item: PresetRecord, f: PresetField): string {
  const v = item.values[f.inputKey];
  if (v === undefined || v === null) return '—';
  const s = String(v);
  return f.type === 'text' && s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function full(item: PresetRecord, f: PresetField): string {
  const v = item.values[f.inputKey];
  return v === undefined || v === null ? '' : String(v);
}

function load_(item: PresetRecord): void {
  emit('apply', item.values);
  open.value = false;
}

async function saveCurrent(): Promise<void> {
  const name = newName.value.trim();
  if (!name) {
    err.value = '请填预设名';
    return;
  }
  busy.value = true;
  err.value = null;
  try {
    await save(props.kind, name, newDesc.value.trim(), extractPreset(props.values, props.targets));
    newName.value = '';
    newDesc.value = '';
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function del(item: PresetRecord): Promise<void> {
  busy.value = true;
  err.value = null;
  try {
    await remove(props.kind, item.name);
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    class="trigger"
    :disabled="props.disabled"
    :title="`预设（${items.length}）`"
    @click="open = true"
  >
    预设<span v-if="items.length" class="n">{{ items.length }}</span>
  </button>

  <!-- 选择对话框 -->
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="open = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <header class="head">
          <h3>选择预设 · {{ title }}</h3>
          <button type="button" class="close" title="关闭" @click="open = false">×</button>
        </header>

        <div class="body">
          <p v-if="state.loading" class="empty">加载中…</p>
          <p v-else-if="items.length === 0" class="empty">
            还没有「{{ title }}」预设 —— 在下方把当前值存成第一个。
          </p>

          <article v-for="it in items" :key="it.id" class="card">
            <!-- 卡片头：名称 + 删除（× 放右上角，不给主操作抢位置） -->
            <header class="card-head">
              <span class="name" :title="it.name">{{ it.name }}</span>
              <button
                type="button"
                class="del"
                :disabled="busy"
                title="删除该预设"
                @click="del(it)"
              >
                ×
              </button>
            </header>

            <!-- 详细内容：按字段元数据渲染 -->
            <div class="detail">
              <div v-for="f in fields" :key="f.inputKey" class="detail-row">
                <span class="dlabel">{{ f.label }}</span>
                <span
                  class="dvalue"
                  :class="{ mono: f.type === 'int', text: f.type === 'text' }"
                  :title="full(it, f)"
                >
                  {{ display(it, f) }}
                </span>
              </div>
            </div>

            <!-- 卡片尾：描述在左、载入在右 -->
            <footer class="card-foot">
              <span class="desc">{{ it.description || '' }}</span>
              <button
                type="button"
                class="btn primary"
                :disabled="props.disabled || busy"
                @click="load_(it)"
              >
                载入
              </button>
            </footer>
          </article>
        </div>

        <footer class="foot">
          <div class="new-title">把当前值存为新预设</div>
          <div class="new-row">
            <input v-model="newName" class="inp" type="text" placeholder="名称（必填）" />
            <input v-model="newDesc" class="inp" type="text" placeholder="描述（可选）" />
            <button type="button" class="btn primary" :disabled="busy" @click="saveCurrent">
              保存
            </button>
          </div>
          <p v-if="err" class="err">{{ err }}</p>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 5px;
  color: #cbd5e1;
  font-size: 11px;
  font-family: inherit;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.trigger:hover:not(:disabled) {
  border-color: #6366f1;
}
.trigger:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.n {
  background: #334155;
  border-radius: 999px;
  padding: 0 4px;
  font-size: 10px;
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(2, 6, 23, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.dialog {
  width: min(560px, 100%);
  max-height: min(84vh, 720px);
  display: flex;
  flex-direction: column;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #1f2937;
}
.head h3 {
  margin: 0;
  font-size: 14px;
  color: #e2e8f0;
}
.close {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}
.close:hover {
  color: #fca5a5;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty {
  margin: 0;
  padding: 20px 8px;
  text-align: center;
  font-size: 12px;
  color: #64748b;
}

.card {
  border: 1px solid #1f2937;
  border-radius: 8px;
  background: #111827;
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #131c2e;
  border-bottom: 1px solid #1f2937;
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.del {
  flex: none;
  background: none;
  border: none;
  color: #64748b;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.del:hover:not(:disabled) {
  color: #fca5a5;
}
.del:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
}
.detail-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  align-items: baseline;
}
.dlabel {
  flex: none;
  width: 3.5em;
  color: #64748b;
  text-align: right;
}
.dvalue {
  flex: 1;
  min-width: 0;
  color: #cbd5e1;
  word-break: break-word;
  white-space: pre-wrap;
}
.dvalue.mono {
  font-family: ui-monospace, monospace;
  color: #a5b4fc;
}
.dvalue.text {
  max-height: 5.4em;
  overflow: hidden;
}

.card-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid #1f2937;
  background: #0f172a;
}
.desc {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-foot .btn {
  flex: none;
}

.foot {
  border-top: 1px solid #1f2937;
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.new-title {
  font-size: 11px;
  color: #64748b;
}
.new-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.inp {
  flex: 1 1 130px;
  min-width: 0;
  background: #111827;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
}
.inp:focus {
  outline: none;
  border-color: #6366f1;
}
.btn {
  border-radius: 6px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  font-size: 12px;
  font-family: inherit;
  padding: 5px 12px;
  cursor: pointer;
  white-space: nowrap;
}
.btn.primary {
  background: #4f46e5;
  border-color: #4f46e5;
  color: #fff;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.err {
  margin: 0;
  font-size: 11px;
  color: #fca5a5;
}
</style>
