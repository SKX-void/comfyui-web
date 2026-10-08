<script setup lang="ts">
import { computed, KeepAlive, ref } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import Icon from './components/Icon.vue';
import { PluginBoundary } from './plugin-boundary';
import { homeLabel, manifestError, orderedTabs, plugins, tabLabel, tabs, uiPrefs } from './store';

const route = useRoute();

/**
 * 插件 tab（`/w/<id>`）的视图自带双栏布局，外壳那条 1000px「阅读宽度」会把它们挤窄，
 * 宽屏上就表现为左右各一大片空白。只给插件视图放宽，文档型视图维持原样。
 */
const wideContent = computed(() => route.path.startsWith('/w/'));

/** 当前路由落在哪个插件上（`/w/<id>` 的 id）；不是插件页就是空串 */
const currentPluginId = computed(() => /^\/w\/([^/]+)/.exec(route.path)?.[1] ?? '');

/**
 * 崩过的插件页不再进常驻缓存。
 *
 * 缓存里那份实例是"补丁停在半路"的状态（见 plugin-boundary.ts）：留着它，下次切回来
 * 只会看到一块没有任何线索的空框 —— 而"切走再回来重新渲染"正是它唯一的恢复机会，
 * 不能因为开了常驻就把这个机会丢掉。
 */
const brokenIds = ref<string[]>([]);

function markBroken(id: string): void {
  if (id === '' || brokenIds.value.includes(id)) return;
  brokenIds.value = [...brokenIds.value, id];
}

/**
 * `<KeepAlive :include>` 的名单 = 「真的挂起来了的插件」∩「设置页开了常驻的」−「崩过的」。
 *
 * 组件名由 main.ts 的 `namedPlugin()` 统一成 `plugin:<id>`（插件自己的 SFC 多半没有 name，
 * 而 Vue 只按组件名匹配 include）。名单是**响应式**的：设置页取消勾选、插件被停用或卸载，
 * 名单立刻收缩，Vue 自己会把对应缓存剪掉。
 */
const keepAliveNames = computed(() =>
  tabs.value
    .filter(
      (tab) =>
        tab.error === undefined &&
        uiPrefs.value.keepAlive.includes(tab.id) &&
        !brokenIds.value.includes(tab.id),
    )
    .map((tab) => `plugin:${tab.id}`),
);

/** 当前这一页是否在常驻名单里（只用来把失败提示写准） */
const currentIsKept = computed(() =>
  keepAliveNames.value.includes(`plugin:${currentPluginId.value}`),
);
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <RouterLink class="brand" to="/home">{{ homeLabel }}</RouterLink>

      <nav class="tabs">
        <RouterLink
          v-for="tab in orderedTabs"
          :key="tab.id"
          class="tab"
          :class="{ broken: tab.error !== undefined }"
          :to="`/w/${tab.id}`"
          :title="tab.error ?? tab.title"
        >
          <!-- 显示别名（设置页配），悬停仍旧给出插件自己的 title -->
          {{ tabLabel(tab) }}
          <span v-if="tab.error !== undefined" class="dot">!</span>
        </RouterLink>
        <span v-if="orderedTabs.length === 0 && manifestError === null" class="empty">还没有插件</span>
      </nav>

      <!-- 设置：图标按钮（原来是一个「设置」文字链接） -->
      <RouterLink class="settings" to="/settings" title="设置" aria-label="设置">
        <Icon name="settings" />
      </RouterLink>
    </header>

    <!--
      清单加载失败必须显形：这种情况下 tab 栏必然是空的，
      如果不提示，看起来和"一个插件都没装"完全一样。
    -->
    <div v-if="manifestError !== null" class="banner">
      <strong>插件清单加载失败</strong>
      <p>{{ manifestError }}</p>
      <p class="banner-hint">
        后端是不是没起、或者端口不对？确认 <code>GET /api/plugins</code> 能返回 JSON
        （宿主的接口全部挂在 <code>/api</code> 下）。当前已登记 {{ plugins.length }} 个插件。
      </p>
    </div>

    <main class="content" :class="{ wide: wideContent }">
      <!-- 插件页面崩了不许带走整个外壳（白屏 + 切 tab 没反应）：见 plugin-boundary.ts -->
      <PluginBoundary
        :reset-key="route.fullPath"
        :plugin-id="currentPluginId"
        :kept="currentIsKept"
        @broken="markBroken"
      >
        <!--
          常驻（切走不卸载）由设置页按插件开关决定，名单来自宿主偏好：见 store 的 uiPrefs.keepAlive。
          include 里没有的 tab 照旧"切走即卸载"—— 不开任何开关时等价于没有 KeepAlive。

          **必须是 `v-slot` 这种写法**：`<KeepAlive><RouterView /></KeepAlive>` 里 KeepAlive 的直接
          子节点是 RouterView 自己（组件名恒为 RouterView），include 永远匹配不上，一个都缓存不住 ——
          实测过（切回来 DOM 还是重建）。用 slot 把**匹配到的那个组件**放到 KeepAlive 底下才对得上名。
        -->
        <RouterView v-slot="{ Component }">
          <KeepAlive :include="keepAliveNames">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </PluginBoundary>
    </main>

  </div>
</template>
