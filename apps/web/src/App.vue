<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import Icon from './components/Icon.vue';
import { PluginBoundary } from './plugin-boundary';
import { homeLabel, manifestError, orderedTabs, plugins, tabLabel } from './store';

const route = useRoute();

/**
 * 插件 tab（`/w/<id>`）的视图自带双栏布局，外壳那条 1000px「阅读宽度」会把它们挤窄，
 * 宽屏上就表现为左右各一大片空白。只给插件视图放宽，文档型视图维持原样。
 */
const wideContent = computed(() => route.path.startsWith('/w/'));
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
      <PluginBoundary :reset-key="route.fullPath">
        <RouterView />
      </PluginBoundary>
    </main>

  </div>
</template>
