<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { plugins } from '../store';

const route = useRoute();
const id = computed(() => String(route.params.id ?? ''));
const plugin = computed(() => plugins.value.find((p) => p.id === id.value));
</script>

<template>
  <div class="page">
    <h2>{{ plugin?.title ?? id }}</h2>
    <p v-if="plugin === undefined" class="error">清单里没有这个插件（是不是刚被卸载？）。</p>
    <template v-else>
      <p v-if="plugin.error" class="error">插件没跑起来：{{ plugin.error }}</p>
      <p v-else class="muted">
        插件已激活，但没有在 <code>client.js</code> 里声明 <code>routes</code>，所以没有可渲染的页面。
      </p>
      <div class="card">
        <div class="kv"><span>id</span><code>{{ plugin.id }}</code></div>
        <div class="kv"><span>服务端入口</span><code>{{ plugin.entry }}</code></div>
        <div class="kv"><span>阶段</span><code>{{ plugin.phase }}</code></div>
      </div>
    </template>
  </div>
</template>
