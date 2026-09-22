<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DepsReport, HelpDoc } from '@comfyui-web/shared';
import { api } from '@/api';
import { renderMarkdown } from '@/md';

/**
 * 帮助面板：**显式展示包内 `readme.md` 的内容**（运行前要装哪些节点包、去哪装）。
 *
 * 以文件为真源（见 `server/help.ts`）：仓库里写什么，界面上就显示什么；人工补充的
 * 说明也会一起出现。文件读不到时退化成"按模板声明实时生成的清单"，不留白屏。
 */
const props = defineProps<{ deps: DepsReport | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const doc = ref<HelpDoc | null>(null);
const html = ref('');
const loading = ref(true);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  try {
    const result = await api.help();
    doc.value = result;
    html.value = result.text === null ? '' : renderMarkdown(result.text);
  } catch (err) {
    doc.value = {
      file: 'readme.md',
      text: null,
      bytes: 0,
      updatedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

/** 顶部状态：与 /api/deps 的三态一致 —— 不知道就说不知道 */
const status = computed<{ text: string; cls: string }>(() => {
  const report = props.deps;
  if (report === null) return { text: '依赖状态：检查中…', cls: '' };
  if (report.ok === null) return { text: '依赖状态：没能确认（连不上 ComfyUI）', cls: 'warn' };
  const missing = report.packs.filter((p) => p.missing.length > 0);
  if (missing.length === 0) return { text: `依赖状态：✓ ${report.packs.length} 个包都在`, cls: 'ok' };
  return { text: `依赖状态：缺 ${missing.map((p) => p.name).join('、')}`, cls: 'bad' };
});

const fallbackPacks = computed(() => props.deps?.packs ?? []);
</script>

<template>
  <div class="help-backdrop" @click.self="emit('close')">
    <div
      class="help-panel"
      role="dialog"
      aria-modal="true"
      aria-label="帮助：运行本工作流需要哪些 ComfyUI 节点包"
    >
      <header class="help-head">
        <h2>帮助 · 运行前需要装什么</h2>
        <span class="help-status" :class="status.cls">{{ status.text }}</span>
        <span class="spacer"></span>
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </header>

      <p v-if="loading" class="help-hint">正在读取 {{ doc?.file ?? 'readme.md' }}…</p>

      <!-- md 由 renderMarkdown 渲染：先转义再套标签，链接只允许 http(s) -->
      <article v-else-if="html !== ''" class="help-md" v-html="html"></article>

      <div v-else class="help-fallback">
        <p class="help-hint">
          包内 <code>{{ doc?.file ?? 'readme.md' }}</code> 读不到（{{ doc?.error ?? '未知原因' }}），
          下面按模板声明实时列出，内容等价。
        </p>
        <ul class="help-packs">
          <li v-for="pack in fallbackPacks" :key="pack.name">
            <a :href="pack.url" target="_blank" rel="noreferrer">{{ pack.name }}</a>
            —— {{ pack.provides.join('、') }}
            <span :class="pack.missing.length > 0 ? 'bad' : 'ok'">
              {{ pack.missing.length > 0 ? `缺 ${pack.missing.length}` : '已装' }}
            </span>
          </li>
        </ul>
      </div>

      <p class="help-foot">
        <template v-if="doc?.updatedAt">来源：包内 {{ doc.file }}（{{ doc.updatedAt.slice(0, 10) }}）·</template>
        Esc 或点击空白处关闭
      </p>
    </div>
  </div>
</template>

<style scoped>
.help-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(2, 6, 23, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.help-panel {
  width: 100%;
  max-width: 720px;
  max-height: 82vh;
  overflow: auto;
  min-width: 0;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 16px 18px 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
.help-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.help-head h2 {
  margin: 0;
  font-size: 15px;
}
.help-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #334155;
  color: #94a3b8;
}
.help-status.ok {
  color: #6ee7b7;
  border-color: #065f46;
}
.help-status.bad {
  color: #fca5a5;
  border-color: #7f1d1d;
}
.help-status.warn {
  color: #fcd34d;
  border-color: #78350f;
}
.spacer {
  flex: 1 1 auto;
}
.help-hint,
.help-foot {
  color: #94a3b8;
  font-size: 12px;
  margin: 6px 0;
}
.help-foot {
  border-top: 1px solid #1e293b;
  padding-top: 8px;
  margin-top: 12px;
}
.help-packs {
  margin: 6px 0;
  padding-left: 18px;
  font-size: 13px;
}
.help-packs li {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.ok {
  color: #6ee7b7;
}
.bad {
  color: #f87171;
}

/* v-html 生成的内容不吃 scoped 属性，必须 :deep() */
.help-md {
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.help-md :deep(h1),
.help-md :deep(h2),
.help-md :deep(h3) {
  font-size: 14px;
  margin: 14px 0 6px;
}
.help-md :deep(p) {
  margin: 8px 0;
}
.help-md :deep(ul),
.help-md :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}
.help-md :deep(li) {
  margin: 4px 0;
}
.help-md :deep(a) {
  color: #93c5fd;
}
.help-md :deep(code) {
  background: #1e293b;
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 12px;
}
.help-md :deep(pre) {
  background: #1e293b;
  border-radius: 6px;
  padding: 10px;
  overflow: auto;
}
.help-md :deep(pre code) {
  background: none;
  padding: 0;
}
.help-md :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 0 2px 10px;
  border-left: 3px solid #334155;
  color: #cbd5e1;
}
.help-md :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
}
.help-md :deep(th),
.help-md :deep(td) {
  text-align: left;
  padding: 5px 8px;
  border-top: 1px solid #334155;
  vertical-align: top;
}
.help-md :deep(th) {
  color: #94a3b8;
  font-weight: 500;
  font-size: 12px;
}
</style>
