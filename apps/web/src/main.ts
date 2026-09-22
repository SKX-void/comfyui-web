import { createApp } from 'vue';
import { createRouter, createWebHistory, type Router } from 'vue-router';

import App from './App.vue';
import './style.css';
import { fetchHostInfo, fetchPlugins, fetchUiPrefs, manifestError, orderedTabs, resolveHome, tabs, uiPrefs } from './store';
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
 * 插件 bundle 里的 `import { ... } from 'vue'` 经页面的 import map 解析到**同一份**
 * Vue 实例（见 index.html），所以插件组件能直接渲染进宿主的组件树。
 */
async function mountPlugin(router: Router, plugin: PluginInfo): Promise<TabEntry> {
  const url = plugin.clientUrl as string;
  // 说明符是运行期才知道的（来自 /api/plugins），必须让打包器放手
  const mod = (await import(/* @vite-ignore */ url)) as { default?: PluginClient };
  const client: PluginClient = mod.default ?? {};

  const base = `/w/${plugin.id}`;
  const routes = client.routes ?? [];
  for (const [index, route] of routes.entries()) {
    router.addRoute({
      path: route.path ? `${base}/${route.path}` : base,
      name: `${plugin.id}:${String(index)}`,
      component: route.component as never,
    });
  }

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
  app.use(router);

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

  // 路由全部登记完再挂载，避免首屏导航落进兜底路由
  app.mount('#app');
}

void bootstrap();
