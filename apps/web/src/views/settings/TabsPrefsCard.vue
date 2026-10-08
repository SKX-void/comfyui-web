<script setup lang="ts">
import { ref } from 'vue';
import { HOME_FALLBACK_LABEL, saveUiPrefs, tabLabel, uiPrefs } from '../../store';
import type { PluginInfo, UiPrefs } from '../../types';
import {
  aliasDrafts,
  canBeHome,
  effectiveHome,
  homeLabelDraft,
  orderedPlugins,
  syncDrafts,
} from './prefs';

const busy = ref(false);
const notice = ref('');

/**
 * 存一次偏好：**只发改动的键**（后端按合并语义处理 —— 见 store 的 saveUiPrefs），
 * 所以这里不需要把整份镜像拼进去，两次并发的保存也不会互相覆盖。
 */
async function persist(patch: Partial<UiPrefs>, note: string): Promise<void> {
  busy.value = true;
  notice.value = '';
  try {
    await saveUiPrefs(patch);
    syncDrafts();
    notice.value = note;
  } catch (err) {
    notice.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    busy.value = false;
  }
}

async function move(id: string, delta: number): Promise<void> {
  const ids = orderedPlugins.value.map((plugin) => plugin.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return;
  next.splice(to, 0, moved);
  await persist({ tabOrder: next }, `顺序已保存：${id} → 第 ${to + 1} 位`);
}

async function setHome(plugin: PluginInfo): Promise<void> {
  await persist(
    { tabOrder: orderedPlugins.value.map((item) => item.id), home: plugin.id },
    `默认首页已设为 ${tabLabel(plugin)}`,
  );
}

/**
 * 保存别名：把**当前列表里所有**输入框一起提交（和顺序一样是"整体存"），
 * 顺带清掉已卸载插件留下的残留键。没改动就不写盘（失焦也会走到这里）。
 */
async function saveAlias(): Promise<void> {
  const next: Record<string, string> = {};
  for (const plugin of orderedPlugins.value) {
    const alias = (aliasDrafts.value[plugin.id] ?? '').trim();
    if (alias !== '') next[plugin.id] = alias;
  }
  if (sameAliases(next, uiPrefs.value.tabAliases)) return;
  await persist({ tabAliases: next }, '显示别名已保存（只改顶栏显示，插件自己的 title 不动）');
}

function sameAliases(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

async function saveHomeLabel(): Promise<void> {
  const next = homeLabelDraft.value.trim();
  if (next === uiPrefs.value.homeLabel) return;
  await persist(
    { homeLabel: next },
    next === ''
      ? `品牌名已清空：回落到内置名 ${HOME_FALLBACK_LABEL}`
      : `品牌名已保存：${next}`,
  );
}

/**
 * 常驻（切走不卸载）开关：**直接存盘**（和「设为首页」一样是一次点击 = 一次决定，没有草稿态）。
 * 存的名单跟着当前列表顺序走，顺带把已卸载插件留下的残留 id 清掉。
 */
async function toggleKeepAlive(plugin: PluginInfo, on: boolean): Promise<void> {
  const next = orderedPlugins.value
    .filter((item) => (item.id === plugin.id ? on : uiPrefs.value.keepAlive.includes(item.id)))
    .map((item) => item.id);
  await persist(
    { keepAlive: next },
    on
      ? `${plugin.title} 已设为切走不卸载：表单、滚动位置和它开着的连接都留着`
      : `${plugin.title} 恢复为切走即卸载`,
  );
}

async function reset(): Promise<void> {
  await persist(
    { tabOrder: [], home: null, tabAliases: {}, homeLabel: '', keepAlive: [] },
    '已恢复默认：按清单顺序、落到第一个可用标签页，显示别名、品牌名与常驻一并清空',
  );
}
</script>

<template>
  <!--
    标签栏顺序 + 默认首页。偏好存在后端的 <dataDir>/host.json（与部署段同处一个文件）；
    这里列的是**清单**（含没跑起来的），顺序按偏好重排。
    任何一处不可用都不会让界面出错：顺序是"过滤+补齐"，首页有回退链。
  -->
  <section class="card ui-prefs">
    <header class="page-head">
      <h3>标签页</h3>
      <button :disabled="busy" @click="reset">恢复默认</button>
    </header>

    <p class="hint">
      顺序决定顶部标签栏的排列，默认首页决定打开站点时落在哪一页。
      <strong>显示别名</strong>只改顶栏上的文字（存在 <code>data/host.json</code> 的偏好段），
      插件自己声明的 title 一个字都不动，也不用重挂插件。
      <strong>切走不卸载</strong>让这个标签页在离开时留在内存里（表单、滚动位置、展开的状态都在），
      代价是它占的内存不会释放 —— 默认关闭，即切走就卸载。
      当前生效：<strong>{{ effectiveHome === null ? '（没有可用标签页，先落在欢迎页）' : tabLabel(effectiveHome) }}</strong>
    </p>
    <p v-if="uiPrefs.home !== null && effectiveHome?.id !== uiPrefs.home" class="hint">
      偏好里的首页 <code>{{ uiPrefs.home }}</code> 当前不可用，已回退到
      <strong>{{ effectiveHome === null ? '欢迎页' : tabLabel(effectiveHome) }}</strong>。
    </p>

    <label class="home-label">
      顶栏品牌链接（首页）的显示名
      <input
        v-model="homeLabelDraft"
        type="text"
        :placeholder="HOME_FALLBACK_LABEL"
        title="留空 = 用内置名"
        @keyup.enter="saveHomeLabel"
        @blur="saveHomeLabel"
      />
      <span class="hint">留空 = 内置名 <code>{{ HOME_FALLBACK_LABEL }}</code></span>
    </label>

    <ul class="tab-order">
      <li v-for="(plugin, index) in orderedPlugins" :key="plugin.id">
        <span class="pos">{{ index + 1 }}</span>
        <strong>{{ plugin.title }}</strong>
        <code class="key">{{ plugin.id }}</code>
        <span class="badge" :class="plugin.phase">{{ plugin.phase }}</span>
        <span v-if="uiPrefs.home === plugin.id" class="badge active">默认首页</span>
        <input
          v-model="aliasDrafts[plugin.id]"
          class="alias"
          type="text"
          :placeholder="plugin.title"
          title="顶栏上的显示别名；留空 = 用插件自己的 title"
          @keyup.enter="saveAlias"
          @blur="saveAlias"
        />
        <label class="keep" title="切走时把这个标签页留在内存里；默认关闭">
          <input
            type="checkbox"
            :checked="uiPrefs.keepAlive.includes(plugin.id)"
            :disabled="busy"
            @change="toggleKeepAlive(plugin, !uiPrefs.keepAlive.includes(plugin.id))"
          />
          切走不卸载
        </label>
        <span class="spacer"></span>
        <button :disabled="busy || index === 0" title="上移" @click="move(plugin.id, -1)">↑</button>
        <button
          :disabled="busy || index === orderedPlugins.length - 1"
          title="下移"
          @click="move(plugin.id, 1)"
        >
          ↓
        </button>
        <button
          :disabled="busy || !canBeHome(plugin)"
          :title="canBeHome(plugin) ? '设为默认首页' : '现在没有可用标签页（未启用 / 未激活 / 加载失败）'"
          @click="setHome(plugin)"
        >
          设为首页
        </button>
      </li>
    </ul>
    <p v-if="notice" class="notice">{{ notice }}</p>
  </section>
</template>
