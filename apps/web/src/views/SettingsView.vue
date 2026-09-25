<script setup lang="ts">
import { computed, ref } from 'vue';
import { putJSON } from '../api';
import {
  fetchHostInfo,
  fetchPlugins,
  fetchUiPrefs,
  hostInfo,
  orderedTabs,
  orderTabs,
  plugins,
  resolveHome,
  saveUiPrefs,
  uiPrefs,
} from '../store';
import type { PluginInfo } from '../types';

const busy = ref<Record<string, string>>({});
const notice = ref<Record<string, string>>({});
/** 展开的插件：默认只展开"没跑起来"的那些（那是真需要动手的） */
const expanded = ref<Record<string, boolean>>({});

function isOpen(plugin: PluginInfo): boolean {
  return expanded.value[plugin.id] ?? plugin.phase !== 'active';
}

function toggleOpen(plugin: PluginInfo): void {
  expanded.value[plugin.id] = !isOpen(plugin);
}

// ---- 标签页顺序 / 默认首页 ----------------------------------------------

const uiBusy = ref(false);
const uiNotice = ref('');

// ---- 宿主全局设置（统一 ComfyUI 地址）-----------------------------------

const globalDraft = ref('');
const globalBusy = ref(false);
const globalNotice = ref('');

/** 把后端清洗后的值同步回输入框（保存之后 / 重新读取时） */
function syncGlobalDraft(): void {
  globalDraft.value = uiPrefs.value.globals.comfyuiBaseUrl;
}

/** 保存统一地址（宿主给的只读默认值，不写进任何插件） */
async function saveGlobal(): Promise<void> {
  globalBusy.value = true;
  globalNotice.value = '';
  try {
    await saveUiPrefs({
      tabOrder: uiPrefs.value.tabOrder,
      home: uiPrefs.value.home,
      globals: { comfyuiBaseUrl: globalDraft.value },
    });
    syncGlobalDraft();
    await fetchPlugins();
    globalNotice.value =
      uiPrefs.value.globals.comfyuiBaseUrl === ''
        ? '已清空：插件可以回落到自己的内置默认值'
        : '已保存（宿主给的只读默认值，不会写进任何插件）';
  } catch (err) {
    globalNotice.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    globalBusy.value = false;
  }
}

/** 设置页里的顺序：以**清单**为准（含没跑起来的那些），用偏好重排 */
const orderedPlugins = computed(() => orderTabs(plugins.value, uiPrefs.value.tabOrder));

/** 当前真正生效的首页（偏好不可用时就是回退链的结果） */
const effectiveHome = computed(() => resolveHome(orderedTabs.value, uiPrefs.value.home));

/** 能否设为首页：现在真的能给出一个能用的 tab */
function canBeHome(plugin: PluginInfo): boolean {
  return orderedTabs.value.some((tab) => tab.id === plugin.id && tab.error === undefined);
}

/** 把"当前看得见的顺序"整体存下去 —— 顺带把已卸载插件的残留 id 清掉 */
async function persist(tabOrder: string[], home: string | null, note: string): Promise<void> {
  uiBusy.value = true;
  uiNotice.value = '';
  try {
    // 必须带上 globals：后端按这次提交重写整个偏好文件，少传就等于把统一地址清空
    await saveUiPrefs({ tabOrder, home, globals: uiPrefs.value.globals });
    uiNotice.value = note;
  } catch (err) {
    uiNotice.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    uiBusy.value = false;
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
  await persist(next, uiPrefs.value.home, `顺序已保存：${id} → 第 ${to + 1} 位`);
}

async function setHome(id: string): Promise<void> {
  await persist(
    orderedPlugins.value.map((plugin) => plugin.id),
    id,
    `默认首页已设为 ${id}`,
  );
}

async function resetUi(): Promise<void> {
  await persist([], null, '已恢复默认：按清单顺序，落到第一个可用标签页');
}

async function refresh(): Promise<void> {
  await fetchHostInfo();
  await fetchUiPrefs();
  syncGlobalDraft();
  await fetchPlugins();
}

async function setEnabled(plugin: PluginInfo, enabled: boolean): Promise<void> {
  busy.value[plugin.id] = enabled ? '启用中…' : '停用中…';
  notice.value[plugin.id] = '';
  try {
    await putJSON(`/api/plugins/${plugin.id}/enabled`, { enabled });
    await refresh();
    notice.value[plugin.id] = enabled ? '已启用' : '已停用（进程内生效，不改文件）';
  } catch (err) {
    notice.value[plugin.id] = `操作失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    delete busy.value[plugin.id];
  }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h2>设置</h2>
      <button @click="refresh">重新读取</button>
    </header>

    <p class="muted">
      插件 = <code>tabs/&lt;id&gt;/</code>（目录即插件），<strong>配置由插件自己持有</strong>
      （存在它自己的 <code>data/plugins/&lt;包名&gt;/</code> 里）：宿主既不读也不写，
      这一页不改任何文件。
      增删 tab 就是把目录放进 / 移出 <code>{{ hostInfo?.tabsDir ?? 'tabs' }}</code>，
      宿主会热重扫，不必重启。
    </p>

    <!--
      标签栏顺序 + 默认首页。偏好存在后端的 <dataDir>/host.json（与部署段同处一个文件）；
      这里列的是**清单**（含没跑起来的），顺序按偏好重排。
      任何一处不可用都不会让界面出错：顺序是"过滤+补齐"，首页有回退链。
    -->
    <!--
      宿主全局设置：统一 ComfyUI 地址。它只是宿主给的一个只读默认值：
      插件可以拿它当兜底，也可以自己配，宿主不把它写进任何插件（D16）。
    -->
    <section class="card host-globals">
      <header class="page-head">
        <h3>统一 ComfyUI 地址</h3>
        <button :disabled="globalBusy" @click="saveGlobal">
          {{ globalBusy ? '保存中…' : '保存' }}
        </button>
      </header>

      <p class="hint">
        插件可以把这里当成<strong>默认地址</strong>（自己的设置留空时用它）；插件自己配了就听它的。
        宿主只保存这个值，不会把它写进任何插件。留空 = 不统一。
      </p>

      <input
        v-model="globalDraft"
        type="text"
        placeholder="http://localhost:8188（可省协议，只写 host:port）"
        @keyup.enter="saveGlobal"
      />
      <p class="hint">
        当前生效：<code>{{ uiPrefs.globals.comfyuiBaseUrl || '（未设置，各插件用自己的）' }}</code>
      </p>
      <p v-if="globalNotice" class="notice">{{ globalNotice }}</p>
    </section>

    <section class="card ui-prefs">
      <header class="page-head">
        <h3>标签页</h3>
        <button :disabled="uiBusy" @click="resetUi">恢复默认</button>
      </header>

      <p class="hint">
        顺序决定顶部标签栏的排列，默认首页决定打开站点时落在哪一页。
        当前生效：<strong>{{ effectiveHome?.title ?? '（没有可用标签页，先落在欢迎页）' }}</strong>
      </p>
      <p v-if="uiPrefs.home !== null && effectiveHome?.id !== uiPrefs.home" class="hint">
        偏好里的首页 <code>{{ uiPrefs.home }}</code> 当前不可用，已回退到
        <strong>{{ effectiveHome?.title ?? '欢迎页' }}</strong>。
      </p>

      <ul class="tab-order">
        <li v-for="(plugin, index) in orderedPlugins" :key="plugin.id">
          <span class="pos">{{ index + 1 }}</span>
          <strong>{{ plugin.title }}</strong>
          <code class="key">{{ plugin.id }}</code>
          <span class="badge" :class="plugin.phase">{{ plugin.phase }}</span>
          <span v-if="uiPrefs.home === plugin.id" class="badge active">默认首页</span>
          <span class="spacer"></span>
          <button :disabled="uiBusy || index === 0" title="上移" @click="move(plugin.id, -1)">↑</button>
          <button
            :disabled="uiBusy || index === orderedPlugins.length - 1"
            title="下移"
            @click="move(plugin.id, 1)"
          >
            ↓
          </button>
          <button
            :disabled="uiBusy || !canBeHome(plugin)"
            :title="canBeHome(plugin) ? '设为默认首页' : '现在没有可用标签页（未启用 / 未激活 / 加载失败）'"
            @click="setHome(plugin.id)"
          >
            设为首页
          </button>
        </li>
      </ul>
      <p v-if="uiNotice" class="notice">{{ uiNotice }}</p>
    </section>

    <section v-for="plugin in plugins" :key="plugin.id" class="plugin-card">
      <header class="plugin-head" @click="toggleOpen(plugin)">
        <div class="plugin-title">
          <strong>{{ plugin.title }}</strong>
          <code class="key">{{ plugin.id }}</code>
          <span v-if="plugin.version" class="version">v{{ plugin.version }}</span>
        </div>
        <div class="plugin-meta">
          <span class="badge" :class="plugin.phase">{{ plugin.phase }}</span>
          <span v-if="plugin.phase === 'rejected'" class="badge rejected">未通过检查</span>
          <span class="chevron">{{ isOpen(plugin) ? '▾' : '▸' }}</span>
        </div>
      </header>

      <div v-if="isOpen(plugin)" class="plugin-body">
        <p v-if="plugin.error" class="error">未运行：{{ plugin.error }}</p>

        <div class="card">
          <div class="kv"><span>服务端入口</span><code>{{ plugin.entry }}</code></div>
          <div class="kv"><span>前端入口</span><code>{{ plugin.clientUrl ?? '（无）' }}</code></div>
        </div>

        <label class="switch">
          <input
            type="checkbox"
            :checked="plugin.enabled"
            :disabled="busy[plugin.id] !== undefined || plugin.phase === 'rejected'"
            @change="setEnabled(plugin, ($event.target as HTMLInputElement).checked)"
          />
          启用（仅本次运行期；tab 的启停不落盘）
        </label>

        <p class="hint">
          配置由插件自己持有（存在它自己的 <code>data/plugins/&lt;包名&gt;/</code> 里），
          这一页只读。要改就到这个插件自己的页面里改 —— 存完由它请求宿主就地重挂，不必重启。
        </p>
        <p v-if="notice[plugin.id]" class="notice">{{ notice[plugin.id] }}</p>
      </div>
    </section>

    <p v-if="plugins.length === 0" class="muted">清单里还没有插件。</p>
  </div>
</template>
