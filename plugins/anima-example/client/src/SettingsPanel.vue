<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from './api';

/**
 * 设置面板：本插件的设置**由自己持有**（空间里的 `settings.json`，见 `server/settings.js`）。
 *
 * 两件事分得很清，别混：
 *   - 字段的**形状**（label / 范围 / 默认值）在 `package.json` 的 `plugin.settings` 里，
 *     由宿主的清单端点下发 —— 这里再抄一份就会烂；
 *   - **值**住在插件自己的空间里，读写都走本插件的 `/settings`。
 *
 * 存完必须让宿主重挂本插件（`POST /api/tabs/<id>/reload`）：`apply()` 只在装载时读一次设置，
 * 而宿主**不碰**本插件的配置，它只提供"重新走一遍装载"这一个动作（决策 D15）。
 */
const PLUGIN_ID = 'anima-example';
const RELOAD_URL = `/api/tabs/${PLUGIN_ID}/reload`;

interface SettingField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea';
  label?: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

const emit = defineEmits<{ (e: 'close'): void }>();

const fields = ref<SettingField[]>([]);
// 值的形状归插件后端（settings.json 自定），前端只负责原样搬进搬出；v-model 只接受
// string/number/... 这几个可绑定的类型，用 any 免得为了迁就表单去给运行时形状编类型
const draft = ref<Record<string, any>>({});
const effective = ref<Record<string, unknown>>({});
const file = ref('');
const loading = ref(true);
const saving = ref(false);
const notice = ref('');
const error = ref('');

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

/** 形状问宿主的清单端点：`plugin.settings` 是唯一真源 */
async function fetchSchema(): Promise<SettingField[]> {
  const res = await fetch('/api/plugins');
  if (!res.ok) throw new Error(`读取插件清单失败：HTTP ${res.status}`);
  const body = (await res.json()) as { plugins?: Array<{ id: string; settings?: SettingField[] }> };
  return body.plugins?.find((plugin) => plugin.id === PLUGIN_ID)?.settings ?? [];
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  try {
    const [schema, current] = await Promise.all([fetchSchema(), api.settings()]);
    fields.value = schema;
    effective.value = current.effective;
    file.value = current.file;
    if (current.error !== undefined) error.value = `设置文件读不出来，这次用的是内置默认值：${current.error}`;
    // 默认值来自 manifest，已存的值盖在上面：界面里看到的=真正会生效的
    const initial: Record<string, unknown> = {};
    for (const field of schema) initial[field.key] = field.default ?? '';
    draft.value = { ...initial, ...current.values };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

async function save(): Promise<void> {
  saving.value = true;
  notice.value = '';
  try {
    await api.saveSettings(draft.value);
    const res = await fetch(RELOAD_URL, { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    notice.value = '已保存，宿主已重挂本插件；页面即将刷新…';
    // 重挂 = 后端换了新实例：整页刷新最省事，也免得住旧数据继续用
    window.setTimeout(() => window.location.reload(), 700);
  } catch (err) {
    notice.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    saving.value = false;
  }
}

const effectiveRows = computed(() => Object.entries(effective.value));
</script>

<template>
  <div class="set-backdrop" @click.self="emit('close')">
    <div class="set-panel" role="dialog" aria-modal="true" aria-label="插件设置">
      <header class="set-head">
        <h2>设置 · 由本插件自己持有</h2>
        <span class="spacer"></span>
        <button class="mini" @click="emit('close')">关闭</button>
      </header>

      <p v-if="loading" class="set-hint">正在读取设置…</p>

      <template v-else>
        <p class="set-hint">
          这些值存在插件自己的空间里（<code>{{ file || 'data/plugins/@comfyui-web+anima-example/settings.json' }}</code>），
          宿主不代管。保存后宿主会重挂本插件，新值随即生效。
        </p>

        <div v-for="field in fields" :key="field.key" class="set-row">
          <label :for="`set-${field.key}`">{{ field.label ?? field.key }}</label>

          <select v-if="field.type === 'select'" :id="`set-${field.key}`" v-model="draft[field.key]">
            <option v-for="option in field.options ?? []" :key="option" :value="option">{{ option }}</option>
          </select>

          <textarea
            v-else-if="field.type === 'textarea'"
            :id="`set-${field.key}`"
            v-model="draft[field.key]"
            rows="4"
          ></textarea>

          <input
            v-else-if="field.type === 'boolean'"
            :id="`set-${field.key}`"
            type="checkbox"
            :checked="draft[field.key] === true"
            @change="draft[field.key] = ($event.target as HTMLInputElement).checked"
          />

          <input
            v-else-if="field.type === 'number'"
            :id="`set-${field.key}`"
            type="number"
            :min="field.min"
            :max="field.max"
            :step="field.step ?? 1"
            v-model.number="draft[field.key]"
          />

          <input v-else :id="`set-${field.key}`" type="text" v-model="draft[field.key]" />

          <p v-if="field.description" class="set-desc">{{ field.description }}</p>
        </div>

        <details class="set-eff">
          <summary>当前生效（本次装载的结论：越界值在这里被收敛）</summary>
          <ul>
            <li v-for="[key, value] in effectiveRows" :key="key">
              <code>{{ key }}</code> = {{ value }}
            </li>
          </ul>
        </details>

        <div class="set-actions">
          <button class="primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存并重挂' }}
          </button>
          <span v-if="notice" class="set-notice">{{ notice }}</span>
        </div>
      </template>

      <p v-if="error" class="bad">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.set-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(2, 6, 23, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.set-panel {
  width: 100%;
  max-width: 640px;
  max-height: 82vh;
  overflow: auto;
  min-width: 0;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 16px 18px 12px;
  color: #e2e8f0;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
.set-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.set-head h2 {
  margin: 0;
  font-size: 15px;
}
.spacer {
  flex: 1 1 auto;
}
.set-hint,
.set-desc,
.set-notice {
  color: #94a3b8;
  font-size: 12px;
  margin: 6px 0;
}
.set-hint code,
.set-eff code {
  background: #1e293b;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.set-row {
  margin: 10px 0;
}
.set-row label {
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}
.set-row input[type='text'],
.set-row input[type='number'],
.set-row select,
.set-row textarea {
  width: 100%;
  box-sizing: border-box;
  background: #1e293b;
  color: inherit;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 6px 8px;
}
.set-eff {
  margin: 12px 0 6px;
  font-size: 12px;
  color: #94a3b8;
}
.set-eff ul {
  margin: 6px 0;
  padding-left: 18px;
}
.set-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid #1e293b;
  padding-top: 10px;
  margin-top: 10px;
}
.set-notice {
  color: #93c5fd;
}
.bad {
  color: #f87171;
  font-size: 12px;
}
</style>
