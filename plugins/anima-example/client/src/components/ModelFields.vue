<script setup lang="ts">
import { useJobContext } from '../composables/useJob';

const { form, options } = useJobContext();
</script>

<template>
  <details class="field">
    <summary>模型（UNET / CLIP / VAE）</summary>
    <label class="field">
      <span>UNET（{{ options?.unet.length ?? 0 }} 个可选）</span>
      <select v-model="form.unet" :title="form.unet">
        <option v-for="m in options?.unet ?? []" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>
    <label class="field">
      <span>CLIP（{{ options?.clip.length ?? 0 }} 个可选）</span>
      <select v-model="form.clip" :title="form.clip">
        <option v-for="m in options?.clip ?? []" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>
    <label class="field">
      <span>VAE（{{ options?.vae.length ?? 0 }} 个可选）</span>
      <select v-model="form.vae" :title="form.vae">
        <option v-for="m in options?.vae ?? []" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>
  </details>
</template>

<style scoped>
.field {
  display: block;
  min-width: 0;
  margin-bottom: 10px;
}
.field > span,
.field > summary {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #94a3b8;
}
.field > summary {
  cursor: pointer;
}
</style>
