/**
 * 「默认Anima」插件的前端入口。
 *
 * 契约（docs/architecture.md §4.4）：默认导出**纯数据** `{ tabs, routes }` ——
 * 插件不创建 app、不碰 router、不渲染 tab 栏。组件挂进宿主的组件树，
 * 所以这里只用裸 `vue` 说明符，交给宿主页面的 import map 解析
 * （为什么必须是同一份 Vue：见 apps/web/src/main.ts 与 docs/architecture.md §7.1）。
 */
import { defineComponent, h } from 'vue';

import App from './src/App.vue';
import './global.css';

const AnimaExampleView = defineComponent({
  name: 'AnimaExampleView',
  setup() {
    return () => h('div', { class: 'cw-anima-example' }, [h(App)]);
  },
});

/** 产物 CSS 与 JS 同目录，运行期用 import.meta.url 定位后自己挂上 */
function injectStylesheet(): void {
  const href = new URL(/* @vite-ignore */ './client.css', import.meta.url).href;
  if (document.querySelector(`link[data-plugin-css="anima-example"]`) !== null) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.pluginCss = 'anima-example';
  document.head.appendChild(link);
}

injectStylesheet();

export default {
  tabs: [{ id: 'anima-example', title: '默认Anima', order: 2 }],
  routes: [{ path: '', component: AnimaExampleView }],
};
