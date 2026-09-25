# `plugins/` —— 插件源码工程：怎么写一个工作流插件

本目录下每个子目录是一个**插件源码工程**（后端 + 前端 + 构建脚本）。宿主**不 import 它们**：
`pnpm build:plugins` 把编译好的产物写进 `tabs/<id>/`（D16），那才是宿主唯一装载的东西。

相关文档分工：产物侧约定（目录名即 id、必须自包含、热重载的边界）见 `tabs/README.md`；
契约与句柄的设计见 `docs/architecture.md` §4/§5；某个配置该落在哪个文件见 `docs/config.md`。
**本文件只讲「从 0 写一个插件」**，机制细节不在这里复述。

## 0. 心智模型

- 一个插件 = 后端（cordis 插件：注册自己的 HTTP 路由 + 存自己的数据）+ 前端（一个 tab 页面，`import` 宿主提供的 vue）。
- 宿主只给两个句柄：`ctx.routes`（路由）与 `ctx.space`（按包名分给你的目录），没有别的框架可依赖。
- **配置与状态归插件自己**（D15）：值住 `ctx.space`（→ `data/plugins/<包名>/`），设置界面在自己的页面里；
  宿主的设置页对这些行只读。
- 插件随时可能被**热重挂**（改产物即卸载重挂，新 fiber）：收尾写在 `ctx.effect`，要活过重挂的状态放 `ctx.space`。

## 1. 最小工程

```text
plugins/mine/
├── package.json          源码 manifest：plugin 段会被原样派生到 tabs/mine/package.json
├── server/index.ts       服务端源码 → tabs/mine/server.js（入口名固定）
├── client/index.ts       前端源码   → tabs/mine/client.js（+ 可选 client.css）
├── client/App.vue
├── scripts/pack.mjs      构建入口：pnpm build:plugins 起来就是跑它
├── scripts/contract-test.mjs   （可选）契约测试
├── vite.config.ts / tsconfig.json
└── workflow.json         （可选）工作流模板等运行期资产
```

起步：直接照 `plugins/anima-example/` 抄（它是最小的一份），或按下面 §2 的四件事自己补齐。

## 2. 四件必写的东西

### 2.1 `package.json` 的 `plugin` 段（契约 + tab 元信息）

```json
{
  "name": "@comfyui-web/mine",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/pack.mjs",
    "dev": "node scripts/pack.mjs --watch",
    "typecheck": "vue-tsc --noEmit",
    "test:contract": "node scripts/contract-test.mjs"
  },
  "plugin": {
    "contract": 1,
    "title": "我的工作流",
    "order": 10,
    "client": "client.js",
    "settings": [
      {
        "key": "comfyuiBaseUrl",
        "type": "string",
        "label": "ComfyUI 地址",
        "default": "http://localhost:8188"
      }
    ]
  }
}
```

- `contract` 是宿主认识的契约版本（当前 `1`）；不符的插件不会被装载，只会带原因显示出来。
- `title` / `order` / `icon` 决定 tab 栏怎么显示；`client` 是前端入口文件名。
- `settings[]` 只是**字段形状**（宿主用它渲染只读说明），**值**由你自己的设置面板写进 `ctx.space`（§5）。
- 不要写 `main` / `exports` / `files`：派生的 manifest 由 `scripts/pack-tab.mjs` 生成（`main` 固定 `server.js`）。

### 2.2 服务端入口

```ts
// plugins/mine/server/index.ts
export const name = 'mine';                 // 插件 id（= 目录名）
export const inject = ['routes', 'space'];  // 只 inject 你真正要用的句柄

export function apply(ctx, config) {
  const store = ctx.space.for('@comfyui-web/mine');   // → data/plugins/@comfyui-web+mine/

  ctx.routes.get('/api/settings', async () => store.readJson('settings.json', {}));
  ctx.routes.put('/api/settings', async (req) => store.writeJson('settings.json', req.body));
  ctx.routes.post('/api/run', async (req) => { /* 提交工作流、返回 prompt_id */ });

  // 收尾：定时器 / 连接 / 子进程都在这里关（重挂时会调用它）
  ctx.effect(() => () => { /* cleanup */ });
}
```

路由在宿主侧统一挂在 `/api/p/<id>` 下：上面的 `/api/settings` 对外就是 `GET /api/p/mine/api/settings`。
**不要** `import 'cordis'`（宿主已经把它打进自己的产物，再引一份就是两个实例）。

### 2.3 前端入口

```ts
// plugins/mine/client/index.ts
import App from './App.vue';

export default {
  tabs: [{ id: 'mine', title: '我的工作流', order: 10 }],
  routes: [{ component: App }],        // 挂到 /w/mine
};
```

- `vue` / `vue-router` 由页面的 import map 提供：**不要**把它们打进 bundle（`vite.config.ts` 里 external）。
- 页面里调自己的后端：`fetch('/api/p/mine/api/settings')`；取自己的静态资产：`/plugins/mine/<文件>`。

### 2.4 构建脚本 `scripts/pack.mjs`

它只做两件事：调构建工具（vite / esbuild），然后把**运行期资产**拷到产物根。照
`plugins/anima-example/scripts/pack.mjs`（最小）或 `plugins/anima-plus/scripts/pack.mjs`（带服务端 bundle + watch）抄：

- 产物目录由 `scripts/pack-tab.mjs` 决定（→ `tabs/<id>/`）；插件里所有 `new URL('./x', import.meta.url)` 都按**产物在 tab 根**来写。
- 在 `extras` 里声明要一起拷过去的资产（模板、图片、帮助文本…）。
- `--watch` 模式供 `pnpm dev:plugins` 常驻使用：改源码边写边出产物，宿主自己热重挂。

## 3. 调 ComfyUI（「API 工作流」这一步）

- **地址从哪来**：插件自己的设置（`ctx.space` 的 `settings.json`）。宿主设置页的「统一 ComfyUI 地址」
  （`data/host.json` 的 `globals.comfyuiBaseUrl`）现在只剩「默认值只读下发」，**不会**自动写进插件的配置（D16/D19）。
- **提交与取结果**：`POST /prompt` 提交（带 `client_id`），`/ws` 收进度，`/history/<prompt_id>` 取产物；
  上传素材走 `/upload/image`。
- **工作流模板**：把 API 格式的 workflow JSON 放工程里（构建时作为 extra 拷进 tab 根），运行时按表单值改节点输入；
  表单字段 ↔ 模板节点的对应关系是插件自己的约定，写在插件里（别指望宿主理解工作流）。
- **产物存放**：出图、缩略图、缓存都放 `ctx.space` 目录下；宿主不代管、不迁移、不清理。
- 参考实现：`plugins/anima-plus/`（进度、模板、缓存、帮助页都有）· `plugins/anima-example/`（单文件最小形态）。
- （待补：错误重试 / 取消 / 并发上限 / 断线重连 —— 把你自己的调用约定写在这几条下面。）

## 4. 前端 tab 的约定

- `export default { tabs, routes }`：`tabs` 进 tab 栏，`routes` 决定 `/w/<id>` 里渲染什么。
- 页面只能通过 HTTP 跟自己的后端说话（没有共享内存）：`/api/p/<id>/...` + 自己的静态资产。
- 设置面板自己出：读写自己的端点（§5），存完请求宿主重挂让新值生效。

## 5. 配置与状态（D15：归插件自己）

- 值写 `ctx.space.for('<包名>')` 下的文件（JSON / SQLite / 随便），格式与迁移自己管。
- 端点自己定义（例如 `GET/PUT /api/settings`），界面放在自己的页面里。
- 存完要让运行中的实例看到新值：`POST /api/tabs/<id>/reload`（指纹没变也强制重挂）。
- 宿主**不会**替你存：`PUT /api/plugins/<id>/config` 对目录型 tab 直接返回 400（这是有意为之）。

## 6. 构建、热重载、验证

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 先 `build:plugins` 垫一次产物，再起宿主 + 外壳（新克隆用这个） |
| `pnpm dev:plugins` | 常驻 watcher：改 `plugins/*` 源码边写边出产物 |
| `pnpm build:plugins` | 一次性构建 → `tabs/<id>/` |
| `pnpm --filter <包名> test:contract` | 契约测试（从 `tabs/<id>/` 读产物做断言） |
| `pnpm verify` | typecheck → smoke → build → tabs-sync → contract |

生效时机（D20，详见 `tabs/README.md`）：**宿主不监听目录** —— 装进去 / 改完在设置页点一次
「重新扫描插件目录」（= `POST /api/tabs/rescan`）才装载或重挂；改 `plugins/*` 的**源码**不会自动生效，
先构建（或让 `pnpm dev:plugins` 常驻出产物）再点重扫。

## 7. 产物里必须带什么

- 入口 `server.js` / `client.js` 必须在 tab 根（宿主认死这两个名字，见 `scripts/pack-tab.mjs`）。
- 运行期要用到的资产（工作流模板、图片、帮助文本）在 `extras` 里声明，一起拷进 tab 根。
- tab 目录里**不许有** `node_modules`：第三方库必须 bundle 进产物（`pnpm verify` 的 `tabs-sync` 会查）。
- `tabs/` **不入库**（构建产物）：仓库只留 `tabs/README.md`。

## 8. 三种文档各写哪儿

| 文档 | 写给谁 | 位置 |
|---|---|---|
| 插件开发说明 | 改这个插件的人 | `plugins/<id>/README.md` |
| 运行期帮助 | 用这个工作流的人（要装哪些节点包、参数怎么填） | `plugins/<id>/readme.md`：声明进 `extras` 会被拷进 tab，插件可用 `new URL('./readme.md', import.meta.url)` 读（见 `anima-plus` 的 `/api/help`） |
| 专题（安全、算法说明…） | 同上 | `plugins/<id>/docs/*.md` |

## 9. 常见坑

- 插件后端 `import 'cordis'` → 两个 cordis 实例，插件行为诡异。
- 前端把 `vue` / `vue-router` 打进 bundle → 与宿主不是同一个实例（响应式/路由都会出怪事）。
- 重挂是新 fiber：内存状态一律归零，收尾必须用 `ctx.effect`。
- 数据写到 `ctx.space` 之外（仓库目录、临时目录）→ 部署时（`dist/` 只读挂载）直接崩。
- 忘了把资产加进 `extras` → 本地能跑（源码目录里有），产物里没有。
