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
 *
 * D26 的常驻（`<KeepAlive>`）给它添了一条新要求：**崩了的实例不许留在缓存里**。缓存里那份是
 * "补丁停在半路"的状态（下面第 ② 条），切回来只会看到一块没有任何线索的空框 —— 所以捕获到错误时
 * 把插件 id 抛给外壳（`broken` 事件），外壳据此把它从 `include` 名单里剔除，Vue 会剪掉对应缓存。
 */
import { defineComponent, h, onErrorCaptured, ref, watch } from 'vue';

export const PluginBoundary = defineComponent({
  name: 'PluginBoundary',
  props: {
    /** 路由标识：一变就清掉失败状态，别让"这个插件崩了"跟着挂到别的 tab 上 */
    resetKey: { type: String, required: true },
    /** 当前是哪个插件的页面（崩了要报给外壳去剔常驻缓存）；非插件页就是空串 */
    pluginId: { type: String, default: '' },
    /** 当前这一页此刻是否在常驻名单里：只影响提示怎么写，不影响任何行为 */
    kept: { type: Boolean, default: false },
  },
  emits: {
    /** 这个插件页面崩了 —— 外壳据此把它移出常驻名单（见 plugin-boundary.ts 头部） */
    broken: (id: string) => id !== '',
  },
  setup(props, { slots, emit }) {
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
      emit('broken', props.pluginId);
      return false;
    });

    // 返回数组 = Fragment，不额外包一层元素（`.content` 的宽度是按它的直接子元素算的）
    return () => [
      failure.value === null
        ? null
        : h('div', { class: 'plugin-failure' }, [
            h('strong', null, '这个插件的页面崩了'),
            h('p', null, failure.value),
            h(
              'p',
              { class: 'plugin-failure-hint' },
              props.kept
                ? '外壳和其它 tab 不受影响；已把它移出常驻缓存，切走再回来会重新渲染。'
                : '外壳和其它 tab 不受影响；切走再回来会重新渲染。',
            ),
          ]),
      slots.default?.(),
    ];
  },
});
