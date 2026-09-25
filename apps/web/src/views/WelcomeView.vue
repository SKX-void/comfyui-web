<script setup lang="ts">
import { ref } from 'vue';
import { hostInfo, plugins, rescanTabs } from '../store';

const scanBusy = ref(false);
const scanNotice = ref('');

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
    <h2>宿主已就绪</h2>
    <p class="muted">
      这是一个只有框架的宿主：前端只提供 tab 挂载点与设置页，后端只提供路由挂载点与
      <strong>按包名分配的插件文件空间</strong>（建库、写 JSON 都由插件自己决定）。
      所有业务能力都来自插件。
    </p>

    <div v-if="hostInfo" class="card">
      <div class="kv"><span>数据目录</span><code>{{ hostInfo.dataDir }}</code></div>
      <div class="kv"><span>tab 目录</span><code>{{ hostInfo.tabsDir }}</code></div>
      <div class="kv"><span>契约版本</span><code>{{ hostInfo.contract }}</code></div>
      <div class="kv"><span>已登记插件</span><code>{{ plugins.length }}</code></div>
    </div>

    <h3>装一个插件</h3>
    <pre class="code">把编译好的目录放进 tabs/：tabs/&lt;id&gt;/{package.json,server.js,client.js}
# 然后点下面的按钮（或 POST /api/tabs/rescan）—— 宿主不监听目录，只在你要求时扫描</pre>
    <p>
      <button :disabled="scanBusy" @click="rescan">
        {{ scanBusy ? '扫描中…' : '重新扫描插件目录' }}
      </button>
    </p>
    <p v-if="scanNotice" class="muted">{{ scanNotice }}</p>
    <p class="muted">
      装插件<strong>不需要重新构建宿主</strong> —— 宿主产物里既没有插件代码，也没有 Vue 本体。
    </p>
  </div>
</template>
