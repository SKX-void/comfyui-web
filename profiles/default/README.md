# 默认 profile：v2 宿主的插件清单与依赖。

这个目录是一个**独立的 pnpm workspace**（dsh 的 profile 同款形态）：

- `plugins.yml` —— 插件清单，由宿主内的 Include 托管（设置页保存时会重写它）。**不入库**，见下。
- `plugins.example.yml` —— 入库的基线模板（`pnpm plugin snapshot` 生成），只有 `id` / `name`。
- `package.json` —— 本 profile 的插件依赖（本地插件是 `link:../../plugins/x`），用 `pnpm plugin add <包>` 增删。
  它是这个**独立 workspace 的根工程**：`name`（`@comfyui-web/profile`）只是为了满足 pnpm，
  **没有任何代码读它**，所以复制/改名 profile 目录（`profiles/personal` 之类）不需要同步改它。
- `node_modules/` —— 插件代码（不提交）。

## 清单不入库：本机状态 vs 入库基线

`plugins.yml` 是"**这批部署的事实**"：设置页会把本机 ComfyUI 地址之类的值写回它的 `config` 段，
连"留空 = 跟随统一设置"的项也存**解析后的地址**（机制与取舍见 `docs/architecture.md` §6 / §5.7）。
所以它和 `data/` 一样属于本机状态，`.gitignore` 已忽略它；入库的是剥掉部署值的模板。

- 改完清单想让基线跟上：`pnpm plugin snapshot`（把 live 清单剥掉 `config` / `disabled` 写进模板）；
- 换机器 / 新克隆：宿主启动发现没有 `plugins.yml` 会**自动从模板复制一份**
  （`apps/server/src/index.ts`），此后这台机器上的改动（地址、启停、额外装的插件）只留在这台机器；
- 要把插件集搬给别人：提 `package.json` 的依赖 + `plugins.example.yml`，**别提交 `plugins.yml`**；
- 只想临时藏住改动、不动仓库结构：`git update-index --skip-worktree profiles/default/plugins.yml`
  （纯本机技巧：上游改这个文件时 `git pull` 会报 "local changes would be overwritten"，且新克隆没有这层保护）。

> **从旧布局迁过来**（`plugins.yml` 还是提交物）要注意：那个提交记录会**删除**这个文件。
> 换机器/部署目录先把它复制到别处，pull 完再放回去（内容不用改，宿主的 Include 照旧读它）；
> 已经配过的地址若不想手抄，也可以 pull 完让宿主从模板重建，再在设置页重填一次。

注意：宿主的设置页会把配置写回 `plugins.yml`，而重写会丢掉文件里的注释。
所以 **请勿在 `plugins.yml`（和模板）里写注释**，说明写在本 README。

清单行的字段：

- `id` —— 本 profile 内唯一；决定路由前缀与前端资源前缀（插件的文件空间按**包名**分配，不跟 id 走）
- `name` —— 模块说明符：裸包名（`@comfyui-web/anima-example`）或相对路径（`./x.mjs`）
- `config` —— 传给插件 `apply(ctx, config)` 的配置（设置页会编辑这一段）。**本机状态，不进模板**
- `disabled` —— 省略即启用；`true` 表示不加载（运行期也能改，见 `PUT /api/plugins/:id/enabled`）。**同样不进模板**
