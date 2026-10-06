import { createApp } from 'vue';
import { createRouter, createWebHistory, type Router } from 'vue-router';

import App from './App.vue';
import './style.css';
import {
  fetchHostInfo,
  fetchPlugins,
  fetchUiPrefs,
  manifestError,
  orderedTabs,
  pluginRoutes,
  resolveHome,
  tabs,
  uiPrefs,
} from './store';
import type { PluginClient, PluginInfo, TabEntry } from './types';
import WelcomeView from './views/WelcomeView.vue';
import SettingsView from './views/SettingsView.vue';
import PluginMissingView from './views/PluginMissingView.vue';

/** 能真正装载前端入口的插件：启用 + 激活 + 声明了 client */
function runnable(plugin: PluginInfo): boolean {
  return plugin.enabled && plugin.phase === 'active' && typeof plugin.clientUrl === 'string';
}

/**
 * 装载一个插件的前端入口。
 *
 * **共享 Vue 是这里的关键**：宿主 index.html 里的 import map 给 `vue` / `vue-router`
 * 一个真实 URL，插件 bundle 里的裸 `import { ... } from 'vue'` 由**浏览器**解析到与宿主
 * 完全相同的模块实例。一旦出现两个 Vue 副本，provide/inject、响应式、组件树全部失效 ——
 * 所以插件 bundle 里的 `external` 是硬要求，不是优化。完整机制见 docs/architecture.md §7.1。
 *
 * 于是插件组件能直接渲染进宿主的组件树，宿主不需要知道插件是谁。
 */
async function mountPlugin(router: Router, plugin: PluginInfo): Promise<TabEntry> {
  const url = plugin.clientUrl as string;
  // 说明符是运行期才知道的（来自 /api/plugins），必须让打包器放手
  const mod = (await import(/* @vite-ignore */ url)) as { default?: PluginClient };
  const client: PluginClient = mod.default ?? {};

  const base = `/w/${plugin.id}`;
  const routes = client.routes ?? [];
  const declaredPaths: string[] = [];
  for (const [index, route] of routes.entries()) {
    const path = route.path ? `${base}/${route.path}` : base;
    declaredPaths.push(path);
    router.addRoute({
      path,
      name: `${plugin.id}:${String(index)}`,
      component: route.component as never,
    });
  }
  // 诊断用：落到兜底页时能列出"它到底声明了哪些路径"
  pluginRoutes.value = { ...pluginRoutes.value, [plugin.id]: declaredPaths };

  const declared = client.tabs?.length
    ? client.tabs
    : [{ id: plugin.id, title: plugin.title, order: plugin.order }];
  const first = declared[0];

  return {
    id: plugin.id,
    title: first?.title ?? plugin.title,
    order: first?.order ?? plugin.order,
  };
}

async function bootstrap(): Promise<void> {
  const app = createApp(App);

  /**
   * 最后一道网：**只记录，不重抛**。
   *
   * dev 构建的 Vue 对没人接住的组件错误是 `throw err`，抛出点在调度器的 flush 里 ——
   * 一个插件页面抛错就能让整个外壳的渲染停摆（切 tab 没反应，只能刷新，实测复现过）。
   * 第一道网是 `PluginBoundary`（包住 RouterView），这里兜住边界之外的那些：
   * 事件回调、watcher、异步任务，以及边界还没挂上的首屏。
   */
  app.config.errorHandler = (err, _instance, info) => {
    console.error(`[host] 未捕获的组件错误（${info}）：`, err);
  };

  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'home', component: WelcomeView },
      // `/` 在有插件时会被上面的守卫送到第一个 tab，欢迎页固定留在 /home
      { path: '/home', name: 'welcome', component: WelcomeView },
      { path: '/settings', name: 'settings', component: SettingsView },
      // 兜底：插件没提供页面 / 页面加载失败时给出可读原因，而不是白屏
      { path: '/w/:id(.*)*', name: 'plugin-missing', component: PluginMissingView },
    ],
  });
  // 根路径送到**默认首页**：偏好里选中的那个 tab；它不可用就按回退链退到第一个可用 tab。
  // 一个 tab 都没有时才留在欢迎页（/home 永远是欢迎页，品牌链接指向它）。
  router.beforeEach((to) => {
    if (to.path !== '/') return true;
    const home = resolveHome(orderedTabs.value, uiPrefs.value.home);
    return home === null ? true : `/w/${home.id}`;
  });

  const collected: TabEntry[] = [];
  try {
    await fetchHostInfo();
    // 偏好要在挂载前拿到：它决定根路径落到哪个 tab（读失败内部会退化成默认值）
    await fetchUiPrefs();
    const list = await fetchPlugins();
    for (const plugin of list) {
      if (!plugin.enabled) continue;
      if (!runnable(plugin)) {
        // 启用了但没跑起来：占一个 tab 把原因摆出来
        collected.push({
          id: plugin.id,
          title: plugin.title,
          order: plugin.order,
          error: plugin.error ?? `插件未激活（${plugin.phase}）`,
        });
        continue;
      }
      try {
        collected.push(await mountPlugin(router, plugin));
      } catch (err) {
        collected.push({
          id: plugin.id,
          title: plugin.title,
          order: plugin.order,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // 拿不到清单 = 一个 tab 都不会有。这种失败必须显示出来，
    // 否则和"没装插件"长得一模一样。
    manifestError.value = err instanceof Error ? err.message : String(err);
    console.error('[host] 插件清单加载失败：', err);
  }

  // 这里存的是**自然顺序**（清单 order,id）；用户偏好的重排是响应式的
  // （store 的 orderedTabs），所以设置页改完顺序，顶栏不用刷新就跟上。
  collected.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  tabs.value = collected;

  // **必须先登记完插件路由、再 `app.use(router)`**：vue-router 的 install 会立刻用
  // `history.location` 发起首次导航，而 addRoute **不会**重新解析当前路由 —— 顺序反了的话，
  // 直接落在 `/w/<id>` 的首屏（默认首页就是这种）会先匹配到兜底路由，插件页面白白显示
  // "没声明 routes"，点一下 tab 才恢复（实测踩过）。
  app.use(router);
  app.mount('#app');
}

void bootstrap();
