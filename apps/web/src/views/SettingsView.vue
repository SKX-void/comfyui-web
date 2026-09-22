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
import SchemaForm from '../components/SchemaForm.vue';

const drafts = ref<Record<string, Record<string, unknown>>>({});
const busy = ref<Record<string, string>>({});
const notice = ref<Record<string, string>>({});
/** 展开的插件：默认只展开"没跑起来"的那些（那是真需要动手的） */
const expanded = ref<Record<string, boolean>>({});

function draftOf(plugin: PluginInfo): Record<string, unknown> {
  if (drafts.value[plugin.id] === undefined) {
    drafts.value[plugin.id] = { ...(plugin.config ?? {}) };
  }
  return drafts.value[plugin.id] as Record<string, unknown>;
}

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

/**
 * 保存统一地址。后端会立刻重算「兜底补丁」，**只有跟随它的插件**就地重载，
 * 并把那批插件的 id 回报回来（following）—— 这里如实转述给用户。
 */
async function saveGlobal(): Promise<void> {
  globalBusy.value = true;
  globalNotice.value = '';
  try {
    const { following, warning } = await saveUiPrefs({
      tabOrder: uiPrefs.value.tabOrder,
      home: uiPrefs.value.home,
      globals: { comfyuiBaseUrl: globalDraft.value },
      following: uiPrefs.value.following,
    });
    syncGlobalDraft();
    await fetchPlugins();
    if (warning !== undefined) {
      globalNotice.value = warning;
    } else if (uiPrefs.value.globals.comfyuiBaseUrl === '') {
      globalNotice.value = '已清空：插件里留空的地址回到各自的内置默认值';
    } else if (following.length > 0) {
      globalNotice.value = `已保存；宿主正在把新地址写进跟随它的 ${following.length} 个插件（写进去会就地重载它们）：${following.join('、')}`;
    } else {
      globalNotice.value = '已保存；当前没有插件留空跟随它（都在自定）';
    }
  } catch (err) {
    globalNotice.value = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    globalBusy.value = false;
  }
}

/** 「留空项到底用的哪个地址」的提示语（来源由后端算好，这里只负责说话） */
function fallbackHint(plugin: PluginInfo): string {
  const entries = Object.entries(plugin.sources ?? {});
  if (entries.length === 0) return '';
  return entries
    .map(([key, source]) => {
      if (source === 'host') {
        return `${key}：跟随统一地址（${uiPrefs.value.globals.comfyuiBaseUrl}）`;
      }
      if (source === 'unset') return `${key}：留空，统一地址也没填 → 用插件自己的默认值`;
      return `${key}：由插件自定`;
    })
    .join('；');
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
    await saveUiPrefs({
      tabOrder,
      home,
      globals: uiPrefs.value.globals,
      following: uiPrefs.value.following,
    });
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
  drafts.value = {};
  await fetchHostInfo();
  await fetchUiPrefs();
  syncGlobalDraft();
  await fetchPlugins();
}

async function save(plugin: PluginInfo): Promise<void> {
  busy.value[plugin.id] = '保存中…';
  notice.value[plugin.id] = '';
  try {
    await putJSON(`/api/plugins/${plugin.id}/config`, { config: draftOf(plugin) });
    await refresh();
    notice.value[plugin.id] = '已保存，宿主已重载该插件';
  } catch (err) {
    notice.value[plugin.id] = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    delete busy.value[plugin.id];
  }
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
      保存会把配置写回 profile 的清单文件
      <code>{{ hostInfo?.manifestFile ?? 'plugins.yml' }}</code>
      ，并让宿主**就地重载**该插件（不必重启）。
      因此<strong>不要在 plugins.yml 里写注释</strong>：重写会丢掉注释。
      增删插件要走命令行 + 重启宿主。
    </p>

    <!--
      标签栏顺序 + 默认首页。偏好存在后端的 <dataDir>/ui-prefs.json；
      这里列的是**清单**（含没跑起来的），顺序按偏好重排。
      任何一处不可用都不会让界面出错：顺序是"过滤+补齐"，首页有回退链。
    -->
    <!--
      宿主全局设置：统一 ComfyUI 地址。插件在 manifest 里给某项声明 fallback: 'comfyuiBaseUrl'，
      留空就跟随这里；插件自己填了值就是自定，宿主不再插手。
    -->
    <section class="card host-globals">
      <header class="page-head">
        <h3>统一 ComfyUI 地址</h3>
        <button :disabled="globalBusy" @click="saveGlobal">
          {{ globalBusy ? '保存中…' : '保存' }}
        </button>
      </header>

      <p class="hint">
        插件里<strong>留空</strong>的 ComfyUI 地址跟随这里；插件自己填了值就以它为准（自定）。
        两边都留空时用插件内置的默认地址。留空 = 不统一。
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
          <span v-if="plugin.phase === 'rejected'" class="badge rejected">契约不符</span>
          <span class="chevron">{{ isOpen(plugin) ? '▾' : '▸' }}</span>
        </div>
      </header>

      <div v-if="isOpen(plugin)" class="plugin-body">
        <p v-if="plugin.error" class="error">未运行：{{ plugin.error }}</p>

        <div class="card">
          <div class="kv"><span>模块</span><code>{{ plugin.specifier }}</code></div>
          <div class="kv"><span>清单行</span><code>{{ plugin.rowId }}</code></div>
          <div class="kv"><span>前端入口</span><code>{{ plugin.clientUrl ?? '（无）' }}</code></div>
        </div>

        <label class="switch">
          <input
            type="checkbox"
            :checked="plugin.enabled"
            :disabled="busy[plugin.id] !== undefined || plugin.phase === 'rejected'"
            @change="setEnabled(plugin, ($event.target as HTMLInputElement).checked)"
          />
          启用（进程内；重启后以 plugins.yml 为准）
        </label>

        <p v-if="fallbackHint(plugin)" class="hint">{{ fallbackHint(plugin) }}</p>

        <SchemaForm
          :fields="plugin.settings"
          :model-value="draftOf(plugin)"
          @update:model-value="drafts[plugin.id] = $event"
        />

        <div class="actions">
          <button :disabled="busy[plugin.id] !== undefined" @click="save(plugin)">
            {{ busy[plugin.id] ?? '保存' }}
          </button>
          <span v-if="notice[plugin.id]" class="notice">{{ notice[plugin.id] }}</span>
        </div>
      </div>
    </section>

    <p v-if="plugins.length === 0" class="muted">清单里还没有插件。</p>
  </div>
</template>
