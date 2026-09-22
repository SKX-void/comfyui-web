<script setup lang="ts">
import { computed } from 'vue';
import type { DepsReport } from '@comfyui-web/shared';

/**
 * 依赖提示条。
 *
 * 设计口径（与「不谎报」一致）：
 * - **只有出问题时才自己冒出来**：当前模板缺节点（红）、或压根没查成（黄）。
 * - 一切正常时它不出现，只在顶栏留一个 `依赖 ✓` 的 pill；点开才看全部清单。
 * - 展开后是**完整安装清单**（每个包 ✓/✗ + GitHub 地址）—— 这正是 readme.md 里
 *   那份链接清单的用途：方便使用者自己核对装没装，包括不在 ComfyUI-Manager 上的包。
 */
const props = defineProps<{
  deps: DepsReport | null;
  templateId: string | null;
  checking: boolean;
}>();

const emit = defineEmits<{ (e: 'refresh'): void; (e: 'close'): void }>();

const current = computed(
  () => props.deps?.templates.find((t) => t.id === props.templateId) ?? null,
);

const state = computed<'ok' | 'bad' | 'unknown' | 'loading'>(() => {
  if (props.deps === null) return 'loading';
  if (props.deps.ok === null) return 'unknown';
  return props.deps.ok ? 'ok' : 'bad';
});

const missingNow = computed(() => current.value?.missing ?? []);
/** 有真问题（当前模板缺节点 / 没查成）时，提示条必须显示，不能收起 */
const mustShow = computed(() => missingNow.value.length > 0 || state.value === 'unknown');

const headline = computed(() => {
  if (state.value === 'loading') return '正在检查依赖…';
  if (state.value === 'unknown') return '无法确认依赖（连不上 ComfyUI）';
  if (missingNow.value.length > 0) {
    return `当前模板缺 ${missingNow.value.length} 个节点，装了才能跑`;
  }
  if (state.value === 'bad') return '有模板缺依赖（当前模板不缺）';
  return '依赖齐全';
});

const packs = computed(() => props.deps?.packs ?? []);
/** 声明里没写出处的缺失节点（作者待补），单独提示，别静默 */
const orphanMissing = computed(() =>
  (props.deps?.missing ?? []).filter((m) => m.pack === null).map((m) => m.classType),
);
</script>

<template>
  <div class="deps" :class="state">
    <div class="deps-head">
      <strong>{{ headline }}</strong>
      <span v-if="deps?.checkedAt" class="deps-meta">
        上游已注册 {{ deps.nodeCount }} 个节点 ·
        {{ deps.cached ? '缓存结果（5 分钟内）' : '刚刚检查' }}
      </span>
      <span class="deps-spacer"></span>
      <button class="btn ghost" :disabled="checking" @click="emit('refresh')">
        {{ checking ? '检查中…' : '重新检查' }}
      </button>
      <button v-if="!mustShow" class="btn ghost" @click="emit('close')">收起</button>
    </div>

    <p v-if="state === 'unknown'" class="deps-hint">
      连不上 ComfyUI，所以<strong>判断不了</strong>依赖是否齐全（这不等于缺依赖）。
      <span v-if="deps?.error" class="deps-err">{{ deps.error }}</span>
    </p>

    <p v-if="current" class="deps-hint">
      当前模板「{{ current.name }}」：
      <strong v-if="current.ready">依赖齐全</strong>
      <strong v-else class="bad">缺 {{ current.missing.length }} 个</strong>
      <span v-if="current.missing.length > 0">— {{ current.missing.join('、') }}</span>
    </p>

    <table v-if="packs.length > 0" class="deps-table">
      <thead>
        <tr>
          <th>节点包</th>
          <th>提供的节点</th>
          <th>状态</th>
          <th>安装地址</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="pack in packs" :key="pack.name" :class="{ bad: pack.missing.length > 0 }">
          <td>
            <strong>{{ pack.name }}</strong>
            <span v-if="pack.optional" class="deps-tag">可选</span>
            <span v-if="pack.note" class="deps-note">{{ pack.note }}</span>
          </td>
          <td class="deps-classes">
            <code v-for="cls in pack.provides" :key="cls" :class="{ 'cls-bad': pack.missing.includes(cls) }">
              {{ cls }}
            </code>
          </td>
          <td class="deps-state">
            <span v-if="pack.missing.length === 0">✓ 已装</span>
            <span v-else class="bad">✗ 缺 {{ pack.missing.length }}</span>
          </td>
          <td><a :href="pack.url" target="_blank" rel="noreferrer">打开 ↗</a></td>
        </tr>
      </tbody>
    </table>

    <p v-if="(deps?.missingBuiltin?.length ?? 0) > 0" class="deps-hint bad">
      ComfyUI 自带节点缺失（装插件包没用，得升级 ComfyUI）：{{ deps?.missingBuiltin.join('、') }}
    </p>
    <p v-if="orphanMissing.length > 0" class="deps-hint">
      这些节点在模板声明里没写出处（作者待补）：{{ orphanMissing.join('、') }}
    </p>
    <p v-if="missingNow.length > 0" class="deps-hint">
      装好节点包后<strong>重启 ComfyUI</strong>，回来点「重新检查」；本插件的表单/历史不受影响。
    </p>
  </div>
</template>

<style scoped>
.deps {
  border: 1px solid #334155;
  border-left-width: 4px;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 14px;
  background: #1e293b;
  font-size: 13px;
  min-width: 0;
}
.deps.bad {
  border-color: #7f1d1d;
  border-left-color: #dc2626;
  background: #2a1416;
}
.deps.unknown {
  border-color: #78350f;
  border-left-color: #d97706;
  background: #2a2114;
}
.deps.ok {
  border-left-color: #16a34a;
}
.deps-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.deps-meta {
  color: #94a3b8;
  font-size: 12px;
}
.deps-spacer {
  flex: 1 1 auto;
}
.deps-hint {
  margin: 8px 0 0;
  color: #cbd5e1;
  overflow-wrap: anywhere;
}
.deps-err {
  color: #94a3b8;
  font-size: 12px;
}
.deps-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
}
.deps-table th,
.deps-table td {
  text-align: left;
  padding: 6px 8px;
  border-top: 1px solid #334155;
  vertical-align: top;
  min-width: 0;
}
.deps-table th {
  color: #94a3b8;
  font-weight: 500;
  font-size: 12px;
}
.deps-table tr.bad td {
  background: rgba(220, 38, 38, 0.08);
}
.deps-note {
  display: block;
  color: #94a3b8;
  font-size: 11px;
  margin-top: 2px;
}
.deps-tag {
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 3px;
  background: #334155;
  color: #cbd5e1;
  font-size: 11px;
}
.deps-classes code {
  display: inline-block;
  margin: 0 4px 4px 0;
  padding: 1px 5px;
  border-radius: 3px;
  background: #0f172a;
  color: #cbd5e1;
  font-size: 11px;
}
.deps-classes code.cls-bad {
  background: rgba(220, 38, 38, 0.25);
  color: #fecaca;
}
.deps-state {
  white-space: nowrap;
}
.bad {
  color: #f87171;
}
</style>
