<script setup lang="ts">
/**
 * 词库面板左边的分类树：全部 / 未分类 / 已有分类。
 *
 * 分类不是装饰 —— 它是"写作时怎么找词"的维度（见 server.js 的 queryTags 按 categories 分组）。
 */
defineProps<{
  categories: { name: string; count: number }[];
  total: number;
  uncategorized: number;
  /** 当前选中的分类名（`''` = 全部，`__none__` = 未分类） */
  active: string;
}>();
const emit = defineEmits<{ (e: 'pick', name: string): void }>();
</script>

<template>
  <nav class="pe-lib-cats">
    <button :class="{ on: active === '' }" @click="emit('pick', '')">
      全部 <em>{{ total }}</em>
    </button>
    <button :class="{ on: active === '__none__' }" @click="emit('pick', '__none__')">
      未分类 <em>{{ uncategorized }}</em>
    </button>
    <button
      v-for="one in categories"
      :key="one.name"
      :class="{ on: active === one.name }"
      @click="emit('pick', one.name)"
    >
      {{ one.name }} <em>{{ one.count }}</em>
    </button>
    <p v-if="categories.length === 0" class="pe-lib-tip">
      还没有分类。<br />点条目上的「改」填分类，填过的会出现在这里。
    </p>
  </nav>
</template>

<style scoped>
.pe-lib-cats {
  flex: 0 0 150px;
  overflow: auto;
  padding: 8px;
  border-right: 1px solid var(--line, #2e333d);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pe-lib-cats button {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
}

.pe-lib-cats button:hover {
  background: var(--panel-2, #22262e);
}

.pe-lib-cats button.on {
  background: var(--panel-2, #22262e);
  color: var(--accent, #6ea8fe);
}

.pe-lib-cats em {
  font-style: normal;
  font-size: 11px;
  color: var(--muted, #9aa3b2);
}

/* 面板本体也有一份：分类树是独立组件，scoped 样式作用不到对方的节点 */
.pe-lib-tip {
  margin: 0;
  padding: 4px 2px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted, #9aa3b2);
  opacity: 0.85;
}
</style>
