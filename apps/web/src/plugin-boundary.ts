/**
 * 插件页面的错误边界：包住 `<RouterView />`，插件页面抛错时只毁掉它自己那一块。
 *
 * 为什么非有不可（不是防御性编程，实测复现过）：dev 构建的 Vue 对**没人接住**的组件错误
 * 是直接 `throw err`（见 `vue.esm-browser.js` 的 `logError`），而抛出点在调度器的
 * `flushJobs` 里 —— 于是
 *   ① 这次 flush 的 promise 变成未处理拒绝（浏览器里就是 `Uncaught (in promise)`）；
 *   ② 补丁停在半路：插件区域空白，**之后每次切 tab 都会再抛
 *      `Cannot read properties of null (reading 'component')`**，不刷新浏览器就一直白着。
 * 两条要求缺一不可：
 *   - `return false`：吃掉错误，别让它继续往上抛（否则 Vue 走的就是上面那条 re-throw 的路）；
 *   - **slot 永远渲染**：RouterView 一旦被卸载，切到别的 tab 就没有东西可渲染，
 *     失败面板会永远挂在那儿（这条也实测过）。
 *
 * 写成渲染函数而不是 SFC：它是"机制"组件，需要在没有浏览器的环境里被真实渲染来验证 ——
 * `apps/web/scripts/isolation-test.mjs` 用宿主 dev 态那份 Vue + 自建 renderer 跑的就是它。
 */
import { defineComponent, h, onErrorCaptured, ref, watch } from 'vue';

export const PluginBoundary = defineComponent({
  name: 'PluginBoundary',
  props: {
    /** 路由标识：一变就清掉失败状态，别让"这个插件崩了"跟着挂到别的 tab 上 */
    resetKey: { type: String, required: true },
  },
  setup(props, { slots }) {
    const failure = ref<string | null>(null);

    watch(
      () => props.resetKey,
      () => {
        failure.value = null;
      },
    );

    onErrorCaptured((err, _instance, info) => {
      failure.value = err instanceof Error ? err.message : String(err);
      console.error(`[host] 插件页面抛错（${info}）：`, err);
      return false;
    });

    // 返回数组 = Fragment，不额外包一层元素（`.content` 的宽度是按它的直接子元素算的）
    return () => [
      failure.value === null
        ? null
        : h('div', { class: 'plugin-failure' }, [
            h('strong', null, '这个插件的页面崩了'),
            h('p', null, failure.value),
            h('p', { class: 'plugin-failure-hint' }, '外壳和其它 tab 不受影响；切走再回来会重新渲染。'),
          ]),
      slots.default?.(),
    ];
  },
});
