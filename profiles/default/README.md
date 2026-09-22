# 默认 profile：v2 宿主的插件清单与依赖。
#
# 这个目录是一个**独立的 pnpm workspace**（dsh 的 profile 同款形态）：
#   - plugins.yml    插件清单，由宿主内的 Include 托管（设置页保存时会重写它）
#   - package.json   本 profile 的插件依赖，用 `pnpm v2:plugin add <包>` 增删
#   - node_modules/  插件代码（不提交）
#
# 注意：宿主的"设置页"会把配置写回 plugins.yml，而重写会丢掉文件里的注释。
# 所以 **请勿在 plugins.yml 里写注释**，说明写在本 README。
#
# 清单行的字段：
#   id       本 profile 内唯一；决定路由前缀与前端资源前缀（插件的文件空间按**包名**分配，不跟 id 走）
#   name     模块说明符：裸包名（@comfyui-web/anima-example）或相对路径（./x.mjs）
#   config   传给插件 apply(ctx, config) 的配置（设置页会编辑这一段）
#   disabled 省略即启用；true 表示不加载（运行期也能改，见 PUT /api/plugins/:id/enabled）
