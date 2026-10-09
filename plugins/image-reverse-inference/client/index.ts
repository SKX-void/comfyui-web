/**
 * 「图片反推」插件的前端入口。
 *
 * 契约：默认导出**纯数据** `{ tabs, routes }` —— 插件不创建 app、不碰 router、不渲染 tab 栏。
 * 组件挂进宿主的组件树，所以这里只用裸 `vue` 说明符，交给宿主页面的 import map 解析。
 */
import { defineComponent, h } from 'vue';

import App from './src/App.vue';
import './global.css';

const ImageReverseInferenceView = defineComponent({
  name: 'ImageReverseInferenceView',
  setup() {
    return () => h('div', { class: 'cw-iri' }, [h(App)]);
  },
});

/** 产物 CSS 与 JS 同目录，运行期用 import.meta.url 定位后自己挂上 */
function injectStylesheet(): void {
  const href = new URL(/* @vite-ignore */ './client.css', import.meta.url).href;
  if (document.querySelector('link[data-plugin-css="image-reverse-inference"]') !== null) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.pluginCss = 'image-reverse-inference';
  document.head.appendChild(link);
}

injectStylesheet();

export default {
  tabs: [{ id: 'image-reverse-inference', title: '图片反推', order: 3 }],
  routes: [{ path: '', component: ImageReverseInferenceView }],
};
