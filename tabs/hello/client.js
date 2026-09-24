/**
 * 前端入口（ESM，**不需要构建**）：一个 tab + 一个页面组件。
 *
 * `import ... from 'vue'` 由页面的 import map 解析到宿主那份**同一个** Vue 实例，
 * 所以这个组件能直接渲染进宿主的组件树（见 apps/web/src/main.ts 的 mountPlugin）。
 *
 * 产物要自带依赖：要第三方库就在这里 bundle 好，别指望 tabs 目录下有 node_modules。
 */
import { defineComponent, h, onMounted, ref } from 'vue';

/** 插件私有接口前缀：`/api/p/<id>`（id = 目录名） */
const API = '/api/p/hello';

const HelloView = defineComponent({
  name: 'HelloTab',
  setup() {
    const info = ref(null);
    const error = ref('');
    const loading = ref(true);

    const load = async () => {
      loading.value = true;
      error.value = '';
      try {
        const response = await fetch(`${API}/api/hello`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        info.value = await response.json();
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
      }
    };

    onMounted(load);

    return () => {
      const children = [
        h('h2', 'Hello 工作流'),
        h(
          'p',
          '这个 tab 就是一个目录：tabs/hello/（package.json + server.js + client.js），没有 node_modules。',
        ),
      ];
      if (loading.value) children.push(h('p', '正在调用 /api/p/hello/api/hello …'));
      if (error.value !== '') children.push(h('p', { style: 'color:#c00' }, `失败：${error.value}`));
      if (info.value) {
        children.push(
          h('ul', [
            h('li', `后端消息：${info.value.message}`),
            h('li', `访问次数（自持在 data/ 里的 state.json）：${info.value.visits}`),
            h('li', `本次装载内服务次数（内存，热重挂 / 重启归零）：${info.value.servedInThisLoad}`),
            h('li', `插件目录：${info.value.pluginDir}`),
            h('li', `数据空间：${info.value.space}`),
          ]),
        );
        children.push(h('button', { onClick: load }, '再调一次'));
      }
      return h('div', { style: 'padding:1rem; line-height:1.8' }, children);
    };
  },
});

export default {
  tabs: [{ id: 'hello', title: 'Hello 工作流', order: 50 }],
  routes: [{ component: HelloView }],
};
