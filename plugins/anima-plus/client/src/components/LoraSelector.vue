<script setup lang="ts">
/**
 * LoRA 选择器：**纯目录浏览**。
 *
 * 设计约束（按需求）：
 * - 每层只显示**当前目录直属**的 LoRA，不递归子目录
 * - 子目录作为可进入的文件夹逐层导航
 * - 不提供搜索
 *
 * 数据来自本服务适配层（/api/loras/browse）。之所以不让前端直接打 WeiLin：
 * WeiLin 的 `get_lora_list` 是 41MB，服务端已缓存并按层切片。
 *
 * 触发词：节点已换成 WeiLin Lora堆（`WeiLinPromptUIOnlyLoraStack`），它**不注入**任何触发词；
 * 词由本插件在提交时拼进质量词之前。这里展示/编辑的是那张覆盖表
 * （`<space>/triggers.json`），解析预览走服务端的同一个 resolver，
 * 所以"看到的"就是"注入的"（plugins/anima-plus/docs/weilin.md §5.3）。
 */
import { onMounted } from 'vue';
import {
  useLoraSelection,
  type LoraSelectorProps,
  type LoraValue,
} from '@/composables/useLoraSelection';
import { useLoraBrowser } from '@/composables/useLoraBrowser';

const props = defineProps<LoraSelectorProps>();
const emit = defineEmits<{ 'update:modelValue': [LoraValue[]] }>();

// 两段状态各自成组：选择+触发词 / 目录浏览。同名解构 → 模板一个字都不用改。
const {
  selected,
  sync,
  commit,
  add,
  remove,
  weightText,
  setWeight,
  states,
  saving,
  saveError,
  defaultWordOf,
  useDefaultOf,
  customOf,
  finalWordOf,
  sourceLabel,
  rowDisabled,
  onToggleDefault,
  onCustomChange,
  refreshResolved,
} = useLoraSelection(props, emit, () => props.disabled === true);
const {
  currentPath,
  breadcrumbs,
  folders,
  items,
  loading,
  loadError,
  open,
  thumbUrl,
  thumbFailed,
  onThumbError,
  parentPath,
  isTrulyEmpty,
  foldersOnly,
} = useLoraBrowser();

onMounted(() => {
  void refreshResolved();
  void open('');
});
</script>


<template>
  <div class="lorasel">
    <!-- 已选 -->
    <div v-if="selected.length === 0" class="hint">尚未选择 LoRA（可留空）</div>
    <div v-for="(l, i) in selected" :key="l.name" class="selected-row">
      <div class="sel-head">
        <span class="sel-name" :title="l.name">{{ l.name.split('\\').pop() }}</span>
        <span class="sel-path">{{ l.name.split('\\').slice(0, -1).join('\\') }}</span>
        <button type="button" class="btn ghost" :disabled="props.disabled" @click="remove(i)">
          移除
        </button>
      </div>

      <div class="sel-body">
        <div class="preview">
          <img
            v-if="l.lora && !thumbFailed[l.lora]"
            :src="thumbUrl(l.lora, 120, 160)"
            class="thumb"
            alt=""
            @error="onThumbError(l.lora!)"
          />
          <div v-else class="thumb placeholder">无预览</div>
        </div>

        <div class="sel-fields">
          <label class="fld fld-range">
            <span>模型权重 <b class="num-val">{{ weightText(l.weight) }}</b></span>
            <input
              class="control range"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="l.weight"
              :disabled="props.disabled"
              @input="setWeight(i, $event)"
            />
          </label>
        </div>

        <!-- 触发词三行：默认（含开关）→ 自定义（可编辑）→ 最终注入词 -->
        <div class="triggers">
          <div class="tr-row">
            <span class="tr-label">默认触发词</span>
            <span v-if="defaultWordOf(l.name)" class="tr-text">{{ defaultWordOf(l.name) }}</span>
            <span v-else class="tr-text muted">无</span>
            <label class="tr-switch" title="关掉后使用下面的自定义词；自定义词留空则不注入">
              <input
                type="checkbox"
                :checked="useDefaultOf(l.name)"
                :disabled="rowDisabled(l.name)"
                @change="onToggleDefault(l.name, $event)"
              />
              <span>使用默认</span>
            </label>
          </div>

          <div class="tr-row">
            <span class="tr-label">自定义注入</span>
            <input
              class="control tr-input"
              type="text"
              :value="customOf(l.name)"
              :disabled="rowDisabled(l.name) || useDefaultOf(l.name)"
              placeholder="留空 = 不注入"
              @change="onCustomChange(l.name, $event)"
            />
          </div>

          <div class="tr-row">
            <span class="tr-label">最终注入词</span>
            <span v-if="finalWordOf(l.name)" class="tr-text final">{{ finalWordOf(l.name) }}</span>
            <span v-else class="tr-text muted">不注入</span>
            <span v-if="sourceLabel(l.name)" class="tr-badge">{{ sourceLabel(l.name) }}</span>
            <span v-if="saving === l.name" class="tr-hint">保存中…</span>
            <span v-if="saveError?.name === l.name" class="tr-err">
              保存失败：{{ saveError.message }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 目录浏览器（文件管理器式） -->
    <div class="fm">
      <!-- 工具栏：位置 + 上一级 -->
      <div class="fm-bar">
        <button
          type="button"
          class="up"
          :disabled="props.disabled || parentPath === null"
          title="返回上一级"
          @click="open(parentPath ?? '')"
        >
          ↑
        </button>
        <div class="crumbs">
          <template v-for="(c, i) in breadcrumbs" :key="c.path">
            <button
              type="button"
              class="crumb"
              :class="{ active: i === breadcrumbs.length - 1 }"
              :disabled="props.disabled || i === breadcrumbs.length - 1"
              @click="open(c.path)"
            >
              {{ c.name }}
            </button>
            <span v-if="i < breadcrumbs.length - 1" class="sep">›</span>
          </template>
        </div>
        <span v-if="loading" class="spin">加载中…</span>
      </div>

      <p v-if="loadError" class="err">
        目录读取失败：{{ loadError }}
        <br />
        <span class="hint">
          若提示"未知接口"，说明后端还是旧版本 —— 刷新页面；仍不行则需重启后端。
        </span>
      </p>

      <!-- 文件夹区（纯文件夹目录也在这里，不会消失） -->
      <template v-if="!loadError">
        <div class="fm-section">
          <div class="fm-head">
            文件夹
            <span class="fm-n">{{ folders.length }}</span>
          </div>
          <div v-if="folders.length" class="fm-list">
            <button
              v-for="f in folders"
              :key="f.path"
              type="button"
              class="fm-row folder"
              :disabled="props.disabled"
              @click="open(f.path)"
            >
              <span class="ico">📁</span>
              <span class="fname">{{ f.name }}</span>
              <span class="meta">{{ f.count > 0 ? `${f.count} 个 LoRA` : '仅含子目录' }}</span>
              <span class="chev">›</span>
            </button>
          </div>
          <p v-else class="fm-empty">没有子文件夹</p>
        </div>

        <!-- LoRA 文件区 -->
        <div class="fm-section">
          <div class="fm-head">
            LoRA 文件
            <span class="fm-n">{{ items.length }}</span>
          </div>
          <div v-if="items.length" class="card-grid">
            <button
              v-for="r in items"
              :key="r.lora"
              type="button"
              class="card"
              :class="{ added: selected.some((s) => s.name === r.name) }"
              :disabled="props.disabled || selected.some((s) => s.name === r.name)"
              :title="r.displayName"
              @click="add(r)"
            >
              <img
                v-if="!thumbFailed[r.lora]"
                :src="thumbUrl(r.lora, 180, 240)"
                class="card-img"
                alt=""
                loading="lazy"
                decoding="async"
                @error="onThumbError(r.lora)"
              />
              <span v-else class="card-img placeholder">🎨</span>
              <span class="card-name">{{ r.displayName }}</span>
              <span v-if="selected.some((s) => s.name === r.name)" class="card-badge">
                已添加
              </span>
            </button>
          </div>
          <p v-else class="fm-empty">
            {{ foldersOnly ? '当前目录只有文件夹，请进入子目录' : '没有 LoRA 文件' }}
          </p>
        </div>

        <p v-if="isTrulyEmpty" class="fm-empty center">该目录是空的</p>
      </template>
    </div>
  </div>
</template>

<style scoped src="./LoraSelector.css"></style>
<style scoped src="./LoraSelector.browser.css"></style>
