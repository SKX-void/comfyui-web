<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { pluginRoutes, plugins } from '../store';

const route = useRoute();
const id = computed(() => String(route.params.id ?? ''));
const plugin = computed(() => plugins.value.find((p) => p.id === id.value));
/** 这个插件前端声明过的路径（空 = 它压根没声明 routes） */
const declared = computed(() => pluginRoutes.value[id.value] ?? []);
/**
 * 前端入口**是否已经装载到这一页**。
 *
 * 后端重扫可以新挂一个插件，但前端入口是首屏 `import()` 出来的 —— 不刷新浏览器就不会有它，
 * 这时"没声明 routes"是个误导性的结论（D20：重扫只动后端）。
 */
const loaded = computed(() => pluginRoutes.value[id.value] !== undefined);
</script>

<template>
  <div class="page">
    <h2>{{ plugin?.title ?? id }}</h2>
    <p v-if="plugin === undefined" class="error">清单里没有这个插件（是不是刚被卸载？）。</p>
    <template v-else>
      <p v-if="plugin.error" class="error">插件没跑起来：{{ plugin.error }}</p>
      <p v-else-if="!loaded" class="muted">
        插件在前端<strong>还没装载</strong>：后端重扫能挂上新插件，但它的 <code>client.js</code>
        是首屏加载进来的 —— <strong>刷新浏览器</strong>就会出现。
      </p>
      <p v-else-if="declared.length === 0" class="muted">
        插件已激活，但它的 <code>client.js</code> 没有声明 <code>routes</code>，所以没有可渲染的页面。
      </p>
      <template v-else>
        <p class="muted">这个地址不在插件声明的路由里（它声明的路径如下）。</p>
        <div class="card">
          <div v-for="path in declared" :key="path" class="kv">
            <span>route</span><code>{{ path }}</code>
          </div>
        </div>
      </template>
      <div class="card">
        <div class="kv"><span>id</span><code>{{ plugin.id }}</code></div>
        <div class="kv"><span>服务端入口</span><code>{{ plugin.entry }}</code></div>
        <div class="kv"><span>阶段</span><code>{{ plugin.phase }}</code></div>
      </div>
    </template>
  </div>
</template>
