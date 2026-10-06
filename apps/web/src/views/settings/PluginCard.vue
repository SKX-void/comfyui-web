<script setup lang="ts">
import { computed, ref } from 'vue';
import { putJSON } from '../../api';
import type { PluginInfo } from '../../types';

const props = defineProps<{
  plugin: PluginInfo;
  /** 启停成功后重读清单（宿主写盘 + Loader 落地之后，界面必须显示**实际**状态） */
  refresh: () => Promise<void>;
}>();

/** 展开的插件：默认只展开"没跑起来"的那些（那是真需要动手的）；用户点过就听用户的 */
const override = ref<boolean | null>(null);
const open = computed(() => override.value ?? props.plugin.phase !== 'active');

const busy = ref('');
const notice = ref('');

function toggle(): void {
  override.value = !open.value;
}

async function setEnabled(enabled: boolean): Promise<void> {
  busy.value = enabled ? '启用中…' : '停用中…';
  notice.value = '';
  try {
    await putJSON(`/api/plugins/${props.plugin.id}/enabled`, { enabled });
    await props.refresh();
    notice.value = enabled ? '已启用（已落盘）' : '已停用（已落盘，重启后仍然停用）';
  } catch (err) {
    notice.value = `操作失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <section class="plugin-card">
    <header class="plugin-head" @click="toggle">
      <div class="plugin-title">
        <strong>{{ plugin.title }}</strong>
        <code class="key">{{ plugin.id }}</code>
        <span v-if="plugin.version" class="version">v{{ plugin.version }}</span>
      </div>
      <div class="plugin-meta">
        <span class="badge" :class="plugin.phase">{{ plugin.phase }}</span>
        <span v-if="plugin.phase === 'rejected'" class="badge rejected">未通过检查</span>
        <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      </div>
    </header>

    <div v-if="open" class="plugin-body">
      <p v-if="plugin.error" class="error">未运行：{{ plugin.error }}</p>

      <div class="card">
        <div class="kv"><span>服务端入口</span><code>{{ plugin.entry }}</code></div>
        <div class="kv"><span>前端入口</span><code>{{ plugin.clientUrl ?? '（无）' }}</code></div>
      </div>

      <label class="switch">
        <input
          type="checkbox"
          :checked="plugin.enabled"
          :disabled="busy !== '' || plugin.phase === 'rejected'"
          @change="setEnabled(($event.target as HTMLInputElement).checked)"
        />
        启用（写进 <code>data/host.json</code> 的 <code>disabled</code>，重启后仍然生效）
      </label>

      <p class="hint">
        配置由插件自己持有（存在它自己的 <code>data/plugins/&lt;包名&gt;/</code> 里），
        这一页只读。要改就到这个插件自己的页面里改 —— 存完由它请求宿主就地重挂，不必重启。
      </p>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </div>
  </section>
</template>
