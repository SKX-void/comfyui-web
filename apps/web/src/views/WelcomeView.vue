<script setup lang="ts">
import { hostInfo, plugins } from '../store';
</script>

<template>
  <div class="page">
    <h2>宿主已就绪</h2>
    <p class="muted">
      这是一个只有框架的宿主：前端只提供 tab 挂载点与设置页，后端只提供路由挂载点与
      <strong>按包名分配的插件文件空间</strong>（建库、写 JSON 都由插件自己决定）。
      所有业务能力都来自插件。
    </p>

    <div v-if="hostInfo" class="card">
      <div class="kv"><span>数据目录</span><code>{{ hostInfo.dataDir }}</code></div>
      <div class="kv"><span>tab 目录</span><code>{{ hostInfo.tabsDir }}</code></div>
      <div class="kv"><span>契约版本</span><code>{{ hostInfo.contract }}</code></div>
      <div class="kv"><span>已登记插件</span><code>{{ plugins.length }}</code></div>
    </div>

    <h3>装一个插件</h3>
    <pre class="code">把编译好的目录放进 tabs/：tabs/&lt;id&gt;/{package.json,server.js,client.js}
# 宿主会热重扫，tab 自动出现（也可以 POST /api/tabs/rescan 手动重扫）</pre>
    <p class="muted">
      装插件<strong>不需要重新构建宿主</strong> —— 宿主产物里既没有插件代码，也没有 Vue 本体。
    </p>
  </div>
</template>
