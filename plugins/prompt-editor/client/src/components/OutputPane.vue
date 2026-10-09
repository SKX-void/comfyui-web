<script setup lang="ts">
/**
 * 输出区：拼接后的**纯文本**。结构只活在左边的编辑区，这里永远是下游真正会拿到的东西。
 * 只读 + 一键复制，不做双向编辑（在这里改文本没法可靠地反推回结构）。
 */
import { computed, ref } from 'vue';

const props = defineProps<{ text: string; itemCount: number; blockCount: number }>();

const copied = ref(false);
let timer: number | null = null;

const stats = computed(() => `${props.text.length} 字符 · ${props.blockCount} 区块 · ${props.itemCount} 条目`);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.text);
  } catch {
    // 剪贴板 API 需要安全上下文；退化到临时 textarea，仍然让"复制"可用
    const area = document.createElement('textarea');
    area.value = props.text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  copied.value = true;
  if (timer !== null) clearTimeout(timer);
  timer = window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

<template>
  <div class="pe-output">
    <div class="pe-output-head">
      <strong>输出</strong>
      <span class="pe-output-mode">tag 块逗号串成一行 · 自然语言块每句一行</span>
      <button class="pe-copy" :disabled="text === ''" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
    </div>
    <pre v-if="text !== ''" class="pe-output-text">{{ text }}</pre>
    <p v-else class="pe-output-empty">左边写点什么，这里就会出现拼接后的纯文本。</p>
    <div class="pe-output-stats">{{ stats }}</div>
  </div>
</template>

<style scoped>
.pe-output {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--line, #2e333d);
  border-radius: 8px;
  background: var(--panel, #1b1e24);
}

.pe-output-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line, #2e333d);
}

.pe-output-mode {
  flex: 1;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

.pe-copy {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: var(--panel-2, #22262e);
  color: inherit;
  font: inherit;
  padding: 3px 10px;
  cursor: pointer;
}

.pe-copy:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pe-output-text {
  flex: 1;
  min-height: 200px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}

.pe-output-empty {
  flex: 1;
  margin: 0;
  padding: 10px;
  color: var(--muted, #9aa3b2);
  font-size: 12.5px;
}

.pe-output-stats {
  padding: 6px 10px;
  border-top: 1px solid var(--line, #2e333d);
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

@media (max-width: 720px) {
  /* 手机上输出区是独立一屏（见 App.vue 的视图切换），不再是右边的一条窄栏 */
  .pe-output-head {
    flex-wrap: wrap;
  }

  /* 那句解释挪到第二行：挤在一行里会把「复制」推出屏幕 */
  .pe-output-mode {
    order: 3;
    flex: 1 1 100%;
  }

  .pe-copy {
    padding: 8px 14px;
  }

  .pe-output-text {
    min-height: 55vh;
  }
}
</style>
