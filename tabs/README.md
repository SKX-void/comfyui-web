# `/tabs` —— 目录型工作流插件

一个**目录**就是一个插件，**目录名即 id**。没有安装步骤、没有清单、没有 `node_modules`。

`tabs/<id>/` 是宿主**唯一**的插件来源（D16/D19）：库里每个子目录都会被扫出来挂进 Loader。

## 源码在哪（D16）

`tabs/<id>/` 是**交付物**，不是源码工程 —— 宿主只装载这里，所以要求「目录里全是编译完的文件」。

| 情况 | 源码 | 产物 |
|---|---|---|
| 有工具链的插件（现在的 anima-plus / anima-example） | `plugins/<id>/`：`server/`、`client/`、`scripts/pack.mjs`、vite/tsconfig | `pnpm build:plugins` → `tabs/<id>/`（**不入库**；`pnpm verify` 的 `tabs-sync` 步只查它能不能装载） |
| 手写 tab | 直接把目录丢进 `tabs/` | 没有构建这一步 |

于是「改插件」分两种：改 `plugins/*` 的源码 → `pnpm build:plugins`（或常驻 `pnpm dev:plugins`，pack.mjs 的 watch 模式边写边出产物）；
改 `tabs/<id>/` 里的文件 → 宿主下一次指纹轮询（约 2s）就热重挂，见下面「热的边界」。
新克隆 / 产物被删之后先跑一次 `pnpm dev`（它先 `build:plugins`）或 `pnpm build:plugins`，否则库里没有 tab。

宿主启动时扫一遍 `tabsDir`（默认 `tabs/`，`data/host.json` 的 `tabsDir` 可改），每个子目录挂成一条
Loader entry：同一份 `package.json` 里的 `plugin` 契约、同一套前端 tab 装载、同一个 `GET /api/plugins`，
**没有第二套生命周期**。

## 写一个自己的 tab

最小骨架（三个文件，零依赖）：

`package.json` —— manifest 与服务端入口：

```json
{
  "name": "@comfyui-web/tab-mine",
  "main": "server.js",
  "plugin": { "contract": 1, "title": "我的工作流", "order": 10, "client": "client.js" }
}
```

`server.js` —— cordis 插件（`name` / `inject` / `apply`；id 同时是路由前缀 `/api/p/<id>`）：

```js
export const name = 'tab-mine';
export const inject = ['routes', 'space'];

export function apply(ctx) {
  const routes = ctx.routes.for('mine');
  routes.get('/api/hello', async () => ({ ok: true }));

  ctx.effect(() => () => {
    // 收尾挂这里：关定时器 / 关文件句柄，否则每次重挂漏一份
  });
}
```

`client.js` —— 前端入口（Vue 走页面 import map，别打进 bundle）：

```js
import { h } from 'vue';

export default {
  tabs: [{ id: 'mine', title: '我的工作流', order: 10 }],
  routes: [{ path: '', component: { setup: () => () => h('div', 'hello') } }],
};
```

约定（host 不再做别的检查，写错就在设置页显示原因）：

| 项 | 规则 |
|---|---|
| 目录名 | `^[a-z][a-z0-9_-]*$`，**即 id**，决定 `/api/p/<id>` 与 `/plugins/<id>/` |
| `package.json` | 必须存在；`main` 是服务端入口（默认 `server.js`）；`plugin` 段就是通常那份 manifest（`contract=1`） |
| `server.js` | `export const name` / `export const inject = ['routes','space']` / `export function apply(ctx)` |
| `client.js` | `export default { tabs: [{ id, title, order }], routes: [{ component }] }`；`import ... from 'vue'` 走页面 import map |
| 数据 | `ctx.space.for('包名')` → `data/plugins/<包名>/`，格式自定、自己迁移、自己清理 |

**必须自包含**：`tabs/` 下没有 `node_modules`，插件只 import node 内置模块和宿主句柄。
要第三方库就先 bundle 进产物（前端本来就这么干；服务端可照 `plugins/anima-plus/scripts/build-server.mjs`）。
`plugins/*` 那类有工具链的插件构建完也是同一个形态（D16），这条线只是多一种"零安装"的来源。

**状态归插件自己**：宿主不持有 tab 的配置 —— 设置写在插件自己的
`ctx.space`（`data/plugins/<包名>/settings.json`），改完由插件请求 `POST /api/tabs/:id/reload` 重新
`apply()`；`PUT /api/plugins/:id/enabled` 只在本次运行期生效。

## 热的边界（诚实版）

| 动作 | 是否热 |
|---|---|
| 增 / 删 / 改名 `tabs/<id>/` 目录 | ✅ 约 0.3s（`fs.watch`）~ 2s（指纹轮询兜底），`GET /api/plugins` 立刻反映，浏览器刷新即见 |
| 改 `tabs/<id>/` 里的代码 | ✅ **也热**：宿主发现目录指纹变了就卸载重挂，说明符带 `?v=<token>` 换掉 URL —— 不同 URL = 新模块实例，绕开 Node 的 ESM 缓存 |
| 改前端 `client.js` | ✅ 后端热 + **浏览器刷新**（`/plugins/<id>/*` 不缓存） |
| 改 `package.json` 的 manifest | ⚠️ 会随下一次重挂生效（`title` / `order` / `client` / `settings`） |

**为什么轮询才是硬保证**：实测 Linux 上 `fs.watch(dir, { recursive: true })` 会**静默失聪**
（连续追加写一次事件都不来，也不报错）。所以"改代码热"靠每 2s 的指纹轮询，监听只是把延迟压到 0.3s。
`POST /api/tabs/rescan` 可随时手动重扫。

**热重挂对插件作者的要求**（重挂 = 销毁旧 fiber 再建新的）：

```js
export function apply(ctx) {
  const timer = setInterval(poll, 1000);
  ctx.effect(() => () => clearInterval(timer));   // 收尾挂这里，否则每次重挂漏一个定时器
}
```

- 内存状态（闭包变量、队列、缓存）**会随重挂归零**；要活下来的写 `ctx.space`。
- 排障时在自己的空间里留一份 load / unload 记录（写进 `ctx.space`），就能直接看"收尾到底跑没跑"。

## 边界

谁能写 `tabs/`，谁就能让**宿主进程执行代码**（同进程、同权限、无沙箱）。
这正是"丢进去就能用"的代价 —— 容器 / 文件权限是唯一边界。

## 决策状态

1. **启停 / 顺序要不要落盘**：✋ 没做 —— tab 的启停目前只在本次运行期生效
   （计划：`data/host.json` 里加 `disabled: []`，宿主扫完按它过滤）。
2. **唯一来源**：✅ 已落地（D16/D19）—— `tabs/` 是宿主唯一装载来源，`profiles/`、Include 装配、
   `pnpm plugin` 与示例 tab 一起删掉了。
3. **安全模型**：✋ 仍是「能写文件 = 能执行代码」，容器 / 文件权限是唯一边界。
