<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchHostInfo, fetchPlugins, fetchUiPrefs, hostInfo, plugins, rescanTabs } from '../store';
import HostGlobalsCard from './settings/HostGlobalsCard.vue';
import PluginCard from './settings/PluginCard.vue';
import TabsPrefsCard from './settings/TabsPrefsCard.vue';
import { syncDrafts, syncGlobalDraft } from './settings/prefs';

// ---- 扫描 tabs/ 目录（D20：宿主不监听文件系统，这里是唯一的装载入口）----

const scanBusy = ref(false);
const scanNotice = ref('');

/**
 * 让宿主重扫目录，然后把结果**如实说清楚**：只说"刷新成功"的话，
 * 用户分不清"目录里真的没问题"和"宿主压根没看见我改的东西"。
 */
async function rescan(): Promise<void> {
  scanBusy.value = true;
  scanNotice.value = '';
  try {
    const result = await rescanTabs();
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`新装载 ${result.added.join('、')}`);
    if (result.reloaded.length > 0) parts.push(`重挂 ${result.reloaded.join('、')}`);
    if (result.removed.length > 0) parts.push(`已卸载 ${result.removed.join('、')}`);
    const failed = result.failed.map((item) => `${item.id}（${item.reason}）`);
    if (failed.length > 0) parts.push(`失败 ${failed.join('、')}`);
    scanNotice.value =
      parts.length === 0
        ? '已重扫：目录内容与已装载的一致，什么都没变'
        : `已重扫：${parts.join('；')}`;
  } catch (err) {
    scanNotice.value = `重扫失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    scanBusy.value = false;
  }
}

/** 重新读一遍宿主信息、偏好与清单，并把输入框草稿回填成真值 */
async function refresh(): Promise<void> {
  await fetchHostInfo();
  await fetchUiPrefs();
  syncGlobalDraft();
  syncDrafts();
  await fetchPlugins();
}

// 首屏进设置页就把已存的值填进输入框：偏好是 bootstrap 时读的，不点「重新读取」也该看到真实值
onMounted(() => {
  syncGlobalDraft();
  syncDrafts();
});
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h2>设置</h2>
      <span class="actions">
        <button :disabled="scanBusy" @click="rescan">
          {{ scanBusy ? '扫描中…' : '重新扫描插件目录' }}
        </button>
        <button @click="refresh">重新读取</button>
      </span>
    </header>

    <p class="muted">
      插件 = <code>tabs/&lt;id&gt;/</code>（目录即插件），<strong>配置由插件自己持有</strong>
      （存在它自己的 <code>data/plugins/&lt;包名&gt;/</code> 里）：宿主既不读也不写，
      这一页不改任何文件。
      增删 tab 就是把目录放进 / 移出 <code>{{ hostInfo?.tabsDir ?? 'tabs' }}</code>，
      然后点上面的「重新扫描插件目录」—— 宿主<strong>不监听</strong>文件系统，
      装载只在启动时和这次点击时发生，不必重启进程。
    </p>
    <p v-if="scanNotice" class="muted hint">{{ scanNotice }}</p>

    <HostGlobalsCard />
    <TabsPrefsCard />

    <PluginCard v-for="plugin in plugins" :key="plugin.id" :plugin="plugin" :refresh="refresh" />

    <p v-if="plugins.length === 0" class="muted">清单里还没有插件。</p>
  </div>
</template>
