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
      <div class="kv"><span>profile</span><code>{{ hostInfo.profile }}</code></div>
      <div class="kv"><span>profile 目录</span><code>{{ hostInfo.profileDir }}</code></div>
      <div class="kv"><span>插件清单</span><code>{{ hostInfo.manifestFile }}</code></div>
      <div class="kv"><span>契约版本</span><code>{{ hostInfo.contract }}</code></div>
      <div class="kv"><span>已登记插件</span><code>{{ plugins.length }}</code></div>
    </div>

    <h3>装一个插件</h3>
    <pre class="code">pnpm plugin add ./plugins/anima-example --id anima-example
# 重启宿主后，tab 会自动出现</pre>
    <p class="muted">
      装插件只需要重启宿主，<strong>不需要重新构建宿主</strong> ——
      宿主产物里既没有插件代码，也没有 Vue 本体。
    </p>
  </div>
</template>
