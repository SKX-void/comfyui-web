# `/tabs` —— 目录型工作流插件（PoC）

一个**目录**就是一个插件，**目录名即 id**。没有安装步骤、没有清单、没有 `node_modules`：

```
tabs/hello/
  package.json    manifest（plugin.contract/title/order/client）+ 服务端入口 main
  server.js       cordis 插件：export name / inject / apply
  client.js       ESM 前端入口：export default { tabs, routes }
```

宿主启动时扫一遍 `tabsDir`（默认 `tabs/`，`host.config.json` 可改），每个子目录挂成一条
Loader entry —— 用的还是 profile 那套东西：同一份 `package.json` 里的 `plugin` 契约、
同一个契约闸门、同一个 `GET /api/plugins`、同一套前端 tab 装载。**没有第二套生命周期。**

它是**同一份契约的第二个来源**：profile 的行写模块说明符（裸包名 / 相对路径），
tab 的行写**服务端入口的绝对路径**。

## 写一个自己的 tab

```bash
cp -r tabs/hello tabs/mine
# 改三处：package.json 的 name、server.js 的 ID/PACKAGE、client.js 的 API 前缀
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
`comfyui-web` 里已经有 npm 包形态的插件，这条线只是多一种"零安装"的来源。

**状态归插件自己**：宿主不持有 tab 的配置——
`PUT /api/plugins/:id/config` 对目录型插件返回 400，`PUT .../enabled` 只在本次运行期生效。
原因是它没有清单文件可写，而"改完没落盘、重启就丢"比明确拒绝更糟。

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
- `tabs/hello/` 把装载 / 卸载留痕写进自己空间的 `lifecycle.log`，可以直接看"收尾到底跑没跑"。

## 边界

谁能写 `tabs/`，谁就能让**宿主进程执行代码**（同进程、同权限、无沙箱）。
这正是"丢进去就能用"的代价 —— 容器 / 文件权限是唯一边界。

## PoC 之后要拍的三件事

1. **唯一真源怎么分权**：现在 profile 清单管"有哪些 + 什么配置"，`tabs/` 是"目录即真源"。
   目录型插件的启停 / 顺序要不要落盘？落在哪（`data/` 还是某个清单）？
2. **要不要退役 profile**：目录型插件自包含，profile 的"依赖解析"职能对它们用不上；
   但只要还有 npm 包形态的插件（`pnpm plugin add`），profile 就仍是它们的落点。
3. **安全模型**：现在只有"能写文件 = 能执行代码"这一条；要不要引入显式启用清单 / 签名。
