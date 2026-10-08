# 项目地址

- 备用仓库地址：[github](https://github.com/SKX-void/comfyui-web)
- 主仓库地址：[git](https://forgejo.teststation2.space/suiyuanXD/comfyui-web)

## 宿主已就绪

这是一个只有框架的宿主：前端只提供 tab 挂载点与设置页，后端只提供路由挂载点与
**按包名分配的插件文件空间**（建库、写 JSON 都由插件自己决定）。所有业务能力都来自插件。

## 装一个插件

把编译好的目录放进 `tabs/`：

```text
tabs/<id>/{package.json,server.js,client.js}
```

然后点下面的按钮（或 `POST /api/tabs/rescan`）—— 宿主不监听目录，只在你要求时扫描。

装插件**不需要重新构建宿主** —— 宿主产物里既没有插件代码，也没有 Vue 本体。

## 数据落在哪

- `data/host.json` —— 宿主唯一的配置文件（端口、tab 顺序、默认首页、启停名单）
- `data/plugins/<包名>/` —— 每个插件的私有空间，宿主不代管、不迁移、不清理

> 本页文案就是这个文件：编译产物里是 `dist/app/web/home.md`（源码在 `apps/web/public/home.md`）。
> 它由外壳直接静态送出、不带缓存，改完刷新浏览器即可生效，不用重新构建。
