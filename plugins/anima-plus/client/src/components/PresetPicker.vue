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

<style scoped src="./PresetPicker.css"></style>
