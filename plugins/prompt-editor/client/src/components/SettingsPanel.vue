<script setup lang="ts">
/**
 * 设置面板（D27）：顶栏「设置…」进来的**一份大设置**，左侧栏分节，右边是当前节的字段。
 *
 * 为什么带左侧栏：翻译、LLM、提示词、将来的别的段都往这里放，一个入口一份设置；
 * 左侧栏是**一棵小树**：`AI`（总闸/凭据/护栏）是父节点，「提示词」（预设 = 有序分段，D30）挂在它下面 ——
 * 提示词是 AI 的附属；翻译设置仍走顶栏那颗「翻译…」（它有自己的面板与用量回执）。
 *
 * z-index 30：AI 卡片（20）里那颗「设置」也开这个面板，得盖在卡片上。
 */
import { ChevronDown, ChevronRight, X } from '@lucide/vue';
import { ref } from 'vue';

import LlmPromptsFields from './LlmPromptsFields.vue';
import LlmSettingsFields from './LlmSettingsFields.vue';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

type SectionId = 'model' | 'prompts';

/**
 * 左侧栏是一棵小树：`AI` 是**纯分组节点**（点它只展开/收起，自己不承载内容），叶子才对应右边的内容 ——
 * 分组行能点开自己那一页的话，树就没意义了。
 */
const sections: { id: string; label: string; children: { id: SectionId; label: string }[] }[] = [
  {
    id: 'ai',
    label: 'AI',
    children: [
      { id: 'model', label: '模型与限额' },
      { id: 'prompts', label: '提示词' },
    ],
  },
];

const section = ref<SectionId>('model');
const expanded = ref(true);
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>设置</strong>
        <button class="pe-close" title="关闭" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="pe-settings">
        <nav class="pe-settings-nav">
          <template v-for="node in sections" :key="node.id">
            <button class="pe-nav-group" :aria-expanded="expanded" @click="expanded = !expanded">
              <span>{{ node.label }}</span>
              <ChevronDown v-if="expanded" :size="14" />
              <ChevronRight v-else :size="14" />
            </button>
            <template v-if="expanded">
              <button
                v-for="child in node.children"
                :key="child.id"
                class="pe-settings-tab pe-nav-child"
                :class="{ on: section === child.id }"
                @click="section = child.id"
              >
                {{ child.label }}
              </button>
            </template>
          </template>
        </nav>

        <div class="pe-settings-body">
          <LlmSettingsFields v-if="section === 'model'" @saved="emit('saved')" />
          <LlmPromptsFields v-else-if="section === 'prompts'" @saved="emit('saved')" />
        </div>
      </div>

      <div class="pe-actions">
        <button class="pe-btn" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pe-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 30;
}

.pe-panel {
  display: flex;
  flex-direction: column;
  width: min(760px, 94vw);
  max-height: 86vh;
  background: var(--panel, #1b1e24);
  border: 1px solid var(--line, #2e333d);
  border-radius: 10px;
  padding: 14px;
}

.pe-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.pe-close {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--muted, #9aa3b2);
  cursor: pointer;
}

.pe-settings {
  display: flex;
  gap: 12px;
  min-height: 0;
  flex: 1;
}

.pe-settings-nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 120px;
  border-right: 1px solid var(--line, #2e333d);
  padding-right: 8px;
}

.pe-settings-tab {
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 12px;
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
}

.pe-settings-tab.on {
  background: var(--panel-2, #22262e);
  color: var(--accent, #6ea8fe);
  font-weight: 600;
}

.pe-settings-tab:hover {
  color: var(--accent, #6ea8fe);
}

/* 分组行：不是叶子，点它只展开/收起 —— 所以它没有「选中」态 */
.pe-nav-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  width: 100%;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #9aa3b2);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
}

.pe-nav-group:hover {
  color: var(--accent, #6ea8fe);
}

/* 树里的子节点：缩进一级 */
.pe-nav-child {
  padding-left: 20px;
  font-size: 11px;
}

/* 只有这一栏滚：面板头与底部「关闭」始终在视口里 */
.pe-settings-body {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

.pe-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.pe-btn {
  border: 1px solid var(--line, #2e333d);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}

.pe-btn:hover:not(:disabled) {
  border-color: var(--accent, #6ea8fe);
  color: var(--accent, #6ea8fe);
}

@media (max-width: 720px) {
  .pe-overlay {
    align-items: stretch;
  }

  .pe-panel {
    width: 100%;
    height: 100vh;
    height: 100dvh;
    max-height: none;
    border: none;
    border-radius: 0;
    padding: 14px 14px calc(14px + env(safe-area-inset-bottom, 0px));
  }

  /* 手机上竖着放不下：左侧栏改成顶上一条横排 */
  .pe-settings {
    flex-direction: column;
  }

  .pe-settings-nav {
    flex-direction: row;
    width: auto;
    border-right: none;
    border-bottom: 1px solid var(--line, #2e333d);
    padding: 0 0 8px;
  }

  .pe-settings-tab {
    text-align: center;
    padding: 6px 12px;
  }

  .pe-nav-child {
    padding-left: 10px;
  }

  /* 横排时分组行不该占满整行 */
  .pe-nav-group {
    width: auto;
  }

  .pe-close svg {
    width: 22px;
    height: 22px;
  }
}
</style>
