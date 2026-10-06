<script setup lang="ts">
import { ref } from 'vue';
import { fetchPlugins, saveUiPrefs, uiPrefs } from '../../store';
import { globalDraft, syncGlobalDraft } from './prefs';

const busy = ref(false);
const notice = ref('');

/** 保存统一地址（宿主给的只读默认值，不写进任何插件） */
async function save(): Promise<void> {
  busy.value = true;
  notice.value = '';
  try {
    await saveUiPrefs({ globals: { comfyuiBaseUrl: globalDraft.value } });
    syncGlobalDraft();
    await fetchPlugins();
    notice.value =
      uiPrefs.value.globals.comfyuiBaseUrl === ''
        ? '已清空：插件可以回落到自己的内置默认值'
        : '已保存（宿主给的只读默认值，不会写进任何插件）';
  } catch (err) {
    notice.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <!--
    宿主全局设置：统一 ComfyUI 地址。宿主只保存、不下发（D16/D19）—— 插件要跟随就自己来
    读 /api/ui（今天两个示例插件都不读，它们的地址来自各自的 settings.json）。
  -->
  <section class="card host-globals">
    <header class="page-head">
      <h3>统一 ComfyUI 地址</h3>
      <button :disabled="busy" @click="save">
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </header>

    <p class="hint">
      留在这里当一台装置的<strong>备忘录</strong>：宿主只保存，不会写进任何插件。
      插件想跟随就自己来读 <code>/api/ui</code>（今天没有插件这么做 —— 它们的地址在各自的设置里）。
    </p>

    <input
      v-model="globalDraft"
      type="text"
      placeholder="http://localhost:8188（可省协议，只写 host:port）"
      @keyup.enter="save"
    />
    <p class="hint">
      当前生效：<code>{{ uiPrefs.globals.comfyuiBaseUrl || '（未设置，各插件用自己的）' }}</code>
    </p>
    <p v-if="notice" class="notice">{{ notice }}</p>
  </section>
</template>
