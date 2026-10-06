<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { putJSON } from '../api';
import {
  fetchHostInfo,
  fetchPlugins,
  fetchUiPrefs,
  HOME_FALLBACK_LABEL,
  hostInfo,
  orderedTabs,
  orderTabs,
  plugins,
  resolveHome,
  rescanTabs,
  saveUiPrefs,
  tabLabel,
  uiPrefs,
} from '../store';
import type { PluginInfo, UiPrefs } from '../types';

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

// ---- 标签页顺序 / 默认首页 / 显示别名 -----------------------------------

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
    await saveUiPrefs({ globals: { comfyuiBaseUrl: globalDraft.value } });
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

// ---- 显示别名（插件 tab + 顶栏品牌链接）--------------------------------

/** 别名草稿（插件 id → 输入框内容）；品牌名同理。保存后由后端清洗的结果回填 */
const aliasDrafts = ref<Record<string, string>>({});
const homeLabelDraft = ref('');

/** 把后端清洗后的值同步回输入框（保存之后 / 重新读取时） */
function syncDrafts(): void {
  aliasDrafts.value = Object.fromEntries(
    orderedPlugins.value.map((plugin) => [plugin.id, uiPrefs.value.tabAliases[plugin.id] ?? '']),
  );
  homeLabelDraft.value = uiPrefs.value.homeLabel;
}

function sameAliases(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// 首屏进设置页就把已存的值填进输入框：偏好是 bootstrap 时读的，不点「重新读取」也该看到真实值
onMounted(() => {
  syncGlobalDraft();
  syncDrafts();
});

/**
 * 存一次偏好：**只发改动的键**（后端按合并语义处理 —— 见 store 的 saveUiPrefs），
 * 所以这里不需要把整份镜像拼进去，两次并发的保存也不会互相覆盖。
 */
async function persist(patch: Partial<UiPrefs>, note: string): Promise<void> {
  uiBusy.value = true;
  uiNotice.value = '';
  try {
    await saveUiPrefs(patch);
    syncDrafts();
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

async function resetUi(): Promise<void> {
  await persist(
    { tabOrder: [], home: null, tabAliases: {}, homeLabel: '' },
    '已恢复默认：按清单顺序、落到第一个可用标签页，显示别名与品牌名一并清空',
  );
}

async function refresh(): Promise<void> {
  await fetchHostInfo();
  await fetchUiPrefs();
  syncGlobalDraft();
  syncDrafts();
  await fetchPlugins();
}

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

async function setEnabled(plugin: PluginInfo, enabled: boolean): Promise<void> {
  busy.value[plugin.id] = enabled ? '启用中…' : '停用中…';
  notice.value[plugin.id] = '';
  try {
    await putJSON(`/api/plugins/${plugin.id}/enabled`, { enabled });
    await refresh();
    notice.value[plugin.id] = enabled ? '已启用（已落盘）' : '已停用（已落盘，重启后仍然停用）';
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

    <!--
      标签栏顺序 + 默认首页。偏好存在后端的 <dataDir>/host.json（与部署段同处一个文件）；
      这里列的是**清单**（含没跑起来的），顺序按偏好重排。
      任何一处不可用都不会让界面出错：顺序是"过滤+补齐"，首页有回退链。
    -->
    <!--
      宿主全局设置：统一 ComfyUI 地址。宿主只保存、不下发（D16/D19）—— 插件要跟随就自己来
      读 /api/ui（今天两个示例插件都不读，它们的地址来自各自的 settings.json）。
    -->
    <section class="card host-globals">
      <header class="page-head">
        <h3>统一 ComfyUI 地址</h3>
        <button :disabled="globalBusy" @click="saveGlobal">
          {{ globalBusy ? '保存中…' : '保存' }}
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
        <strong>显示别名</strong>只改顶栏上的文字（存在 <code>data/host.json</code> 的偏好段），
        插件自己声明的 title 一个字都不动，也不用重挂插件。
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
            @click="setHome(plugin)"
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
          启用（写进 <code>data/host.json</code> 的 <code>disabled</code>，重启后仍然生效）
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
