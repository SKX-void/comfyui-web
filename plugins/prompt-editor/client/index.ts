/**
 * 「提示词编辑器」插件的前端入口。
 *
 * 契约（docs/architecture.md §4.4）：默认导出**纯数据** `{ tabs, routes }` ——
 * 插件不创建 app、不碰 router、不渲染 tab 栏。组件挂进宿主的组件树，
 * 所以这里只用裸 `vue` 说明符，交给宿主页面的 import map 解析。
 */
import { defineComponent, h } from 'vue';

import App from './src/App.vue';
import './global.css';

const PromptEditorView = defineComponent({
  name: 'PromptEditorView',
  setup() {
    return () => h('div', { class: 'cw-prompt-editor' }, [h(App)]);
  },
});

/** 产物 CSS 与 JS 同目录，运行期用 import.meta.url 定位后自己挂上 */
function injectStylesheet(): void {
  const href = new URL(/* @vite-ignore */ './client.css', import.meta.url).href;
  if (document.querySelector(`link[data-plugin-css="prompt-editor"]`) !== null) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.pluginCss = 'prompt-editor';
  document.head.appendChild(link);
}

injectStylesheet();

export default {
  tabs: [{ id: 'prompt-editor', title: '提示词编辑器', order: 3 }],
  routes: [{ path: '', component: PromptEditorView }],
};
