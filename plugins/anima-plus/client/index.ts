/**
 * 文生图插件的**前端入口**。
 *
 * 契约（见 docs/architecture.md §4.4）：默认导出纯数据 `{ tabs, routes }` ——
 * 插件不创建 app、不碰 router、不渲染 tab 栏。组件挂进宿主的组件树，
 * 因此 `import ... from 'vue'` 必须由宿主的 import map 解析（同一份 Vue 实例）。
 */
import { defineComponent, h } from 'vue';

import App from './src/App.vue';
import './global.css';

/**
 * 旧单页的全局样式（body/#app 的底色、字体）被收敛到 `.cw-anima-plus` 作用域下，
 * 否则它会把宿主外壳的深色主题一起改掉。见 global.css 顶部说明。
 */
const AnimaPlusView = defineComponent({
  name: 'AnimaPlusView',
  setup() {
    return () => h('div', { class: 'cw-anima-plus' }, [h(App)]);
  },
});

/**
 * 样式表由插件自己挂上：产物 CSS 与 JS 同目录，用 `import.meta.url` 定位即可，
 * 不需要宿主提供额外的挂载点，也不需要把 CSS 拼进 JS 字符串。
 */
function injectStylesheet(): void {
  // 运行期才定位：产物在宿主上是 /plugins/anima-plus/lib/client.js，
  // 同目录的 client.css 直接由 import.meta.url 推出，构建期不需要它存在。
  const href = new URL(/* @vite-ignore */ './client.css', import.meta.url).href;
  if (document.querySelector(`link[data-plugin-css="anima-plus"]`) !== null) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.pluginCss = 'anima-plus';
  document.head.appendChild(link);
}

injectStylesheet();

/**
 * 具名导出：md 渲染器，**只给契约测试用**（宿主只认 default 导出）。
 * 放在产物里测，才能挡住"源码改了、产物没跟上"。
 */
export { renderMarkdown } from './src/md';

export default {
  tabs: [{ id: 'anima-plus', title: 'Anima Plus', order: 1 }],
  routes: [{ path: '', component: AnimaPlusView }],
};
