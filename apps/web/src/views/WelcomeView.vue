<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { marked } from 'marked';

import { getText } from '../api';
import { hostInfo, plugins, rescanTabs } from '../store';

/**
 * 首页说明来自 `public/home.md` —— 外壳把它当**静态资源**直接送出（生产态是
 * `dist/app/web/home.md`），所以改产物里的那个文件、刷新浏览器就生效，不用重构建。
 * 后端不参与这条链路：渲染（md → HTML）在 home 路由自己做。
 */
const doc = ref('');
const docError = ref('');

const scanBusy = ref(false);
const scanNotice = ref('');

onMounted(async () => {
  try {
    doc.value = await marked.parse(await getText('/home.md'));
  } catch (err) {
    docError.value = err instanceof Error ? err.message : String(err);
  }
});

async function rescan(): Promise<void> {
  scanBusy.value = true;
  scanNotice.value = '';
  try {
    const result = await rescanTabs();
    const count = result.added.length + result.reloaded.length + result.removed.length;
    scanNotice.value =
      count === 0
        ? '已重扫：tabs/ 目录里没有新变化'
        : `已重扫：新装载 ${result.added.length} 个、重挂 ${result.reloaded.length} 个、卸载 ${result.removed.length} 个`;
  } catch (err) {
    scanNotice.value = `重扫失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    scanBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <p v-if="docError" class="error">首页说明（/home.md）加载失败：{{ docError }}</p>
    <!-- v-html 是刻意的：内容是部署者自己的 md（与宿主同权限），不是用户输入 -->
    <div v-else class="doc" v-html="doc"></div>

    <div v-if="hostInfo" class="card">
      <div class="kv"><span>数据目录</span><code>{{ hostInfo.dataDir }}</code></div>
      <div class="kv"><span>tab 目录</span><code>{{ hostInfo.tabsDir }}</code></div>
      <div class="kv"><span>契约版本</span><code>{{ hostInfo.contract }}</code></div>
      <div class="kv"><span>已登记插件</span><code>{{ plugins.length }}</code></div>
    </div>

    <p>
      <button :disabled="scanBusy" @click="rescan">
        {{ scanBusy ? '扫描中…' : '重新扫描插件目录' }}
      </button>
    </p>
    <p v-if="scanNotice" class="muted">{{ scanNotice }}</p>
  </div>
</template>
