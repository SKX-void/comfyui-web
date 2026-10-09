<script setup lang="ts">
/**
 * 区块库的列表区：每行 = 一块（名字 / 风格 / 条数 / 时间 / 分类）+ 操作按钮。
 *
 * **点一行展开看这一块的全部条目，默认收着**：列表里的摘要只带前几条预览，全铺出来一份几百条的
 * 库就没法看了；展开时按 id 取整条（`useBlockLibrary.toggleExpand`）。
 *
 * **浏览模式只有「插入」**，改名 / 删除收在编辑模式里（跟词库面板同一套）: 进来找块插块是高频动作，
 * 改库是低频动作，混在一起每次都要在一排按钮里认路。
 *
 * 改名 / 删确认都是**就地**的（不用 `window.prompt/confirm`：弹窗打断操作，样式也不跟面板一致），
 * 状态在 `useBlockLibrary`（一次只有一行在改，没必要每行一套）。删除要两步。
 *
 * **归类与排序都靠拖**（跟词库面板同一套）：行拖到左栏的分类上 = 归到它，拖到「未分类」= 摘掉；
 * 行拖到行上 = 排顺序。不再给每行配一个下拉 —— 拖是"用手比划一下"，下拉是"先找控件再选"，
 * 而且左栏本来就在那儿摆着。
 *
 * 只是展示 + 交互：请求、busy、错误提示都在面板那一侧（`useBlockLibrary`）。
 */
import { ref, watch } from 'vue';

import type { BlockCategorySummary, BlockPresetSummary } from '../api';
import { MODE_LABEL } from '../model';

const props = defineProps<{
  presets: BlockPresetSummary[];
  categories: BlockCategorySummary[];
  /** 正在插入的那一条：其余按钮跟着禁用，避免连点 */
  busyId: string;
  /** 左栏正筛着某个分类：空列表的文案得说清"是这个分类空"，别说成"库是空的" */
  filtered: boolean;
  editMode: boolean;
  /** 正被拖的那一行（块 id）—— 拖拽状态在 useBlockLibrary，落点在左栏，得跨组件 */
  draggingKey: string;
  /** 落点：插到第 index 行之前（`-1` = 没有落点） */
  dropIndex: number;
  /** 筛过的视图里不给排序（新顺序是相对子集说的，落盘会错位） */
  sortable: boolean;
  /** 多选模式：行上出现勾，操作按钮收起来（这会儿是在挑要导出的几块） */
  picking: boolean;
  /** 已经勾上的块 id（选择集在面板那一侧，这里只画） */
  pickedIds: string[];
  /** 正在就地改名的那一行 / 名字草稿 / 待确认删除的那一行（一次只有一行） */
  renamingId: string;
  renameTo: string;
  confirmRemoveId: string;
  /** 展开了条目的那一行（块 id）：`''` = 全都收着（默认），条目展开时才按 id 取整条 */
  expandedId: string;
  expandedItems: string[];
  expandBusy: boolean;
}>();

const emit = defineEmits<{
  (e: 'insert', preset: BlockPresetSummary): void;
  (e: 'toggle-pick', id: string): void;
  (e: 'toggle-expand', preset: BlockPresetSummary): void;
  (e: 'start-rename', preset: BlockPresetSummary): void;
  (e: 'cancel-rename'): void;
  (e: 'update:renameTo', value: string): void;
  (e: 'submit-rename'): void;
  (e: 'ask-remove', preset: BlockPresetSummary): void;
  (e: 'cancel-remove'): void;
  (e: 'submit-remove'): void;
  (e: 'drag-start', preset: BlockPresetSummary): void;
  (e: 'drag-end'): void;
  (e: 'row-drag-over', index: number, event: DragEvent): void;
  (e: 'row-drop'): void;
}>();

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** 行上那个分类小标签：没归类时也显示「未分类」，不然"这块属于谁"是空白 */
function categoryLabel(preset: BlockPresetSummary): string {
  if (preset.categoryId === '') return '未分类';
  return props.categories.find((one) => one.id === preset.categoryId)?.name ?? '未分类';
}

/**
 * 改名框出现时要**自己抢焦点**（跟左栏的分类输入一致）：不抢的话敲键盘什么也不会发生 ——
 * `@keyup.enter / @keyup.esc` 挂在输入框上，没焦点就永远不触发，看着就是"点了没反应"。
 *
 * 输入框在 `v-for` 里，模板 ref 拿到的是数组（同一时刻只有一行在改，所以数组里至多一个）。
 * `flush: 'post'`：等这次渲染换完再抢（默认的 pre 时机里 ref 还是空的）。
 */
const renameBox = ref<HTMLInputElement[] | null>(null);
watch(
  () => props.renamingId,
  (id) => {
    if (id === '') return;
    const box = Array.isArray(renameBox.value) ? renameBox.value[0] : renameBox.value;
    box?.focus();
    box?.select();
  },
  { flush: 'post' },
);
</script>

<template>
  <ul class="pe-list">
    <li
      v-for="(preset, index) in presets"
      :key="preset.id"
      class="pe-item"
      :class="{
        'pe-item-open': expandedId === preset.id,
        'pe-item-dragging': draggingKey === preset.id,
        'pe-item-picking': picking,
        'pe-item-over-before': sortable && draggingKey !== '' && dropIndex === index,
        'pe-item-over-after': sortable && draggingKey !== '' && dropIndex === index + 1,
      }"
      :draggable="editMode ? 'true' : 'false'"
      @dragstart="emit('drag-start', preset)"
      @dragend="emit('drag-end')"
      @dragover.prevent="sortable && emit('row-drag-over', index, $event)"
      @drop.prevent="sortable && emit('row-drop')"
      @click="picking && emit('toggle-pick', preset.id)"
    >
      <!-- 多选：勾在行首，点行上哪儿都算（手机上 18px 的方框点不准） -->
      <input
        v-if="picking"
        class="pe-pick"
        type="checkbox"
        :checked="pickedIds.includes(preset.id)"
        :aria-label="`选择「${preset.name}」`"
        @click.stop
        @change="emit('toggle-pick', preset.id)"
      />
      <!-- 六点手柄（内联 SVG）：告诉人"这行能拖"。只在编辑模式出现，浏览模式这行是只读的 -->
      <span v-if="editMode" class="pe-grip" title="拖动：排顺序 / 拖到左栏分类上归类" aria-hidden="true">
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2" cy="3" r="1.4" />
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="2" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="2" cy="13" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </span>
      <div class="pe-item-main">
        <!-- 就地改名：回车提交、Esc 取消（名字没变就不发请求） -->
        <input
          v-if="renamingId === preset.id"
          ref="renameBox"
          class="pe-item-rename"
          :value="renameTo"
          @input="emit('update:renameTo', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('submit-rename')"
          @keyup.esc="emit('cancel-rename')"
        />
        <!-- 点这一块展开/收起：**默认收起**（一块能存几百条，全铺出来列表就没法看了） -->
        <span
          v-else
          class="pe-item-head"
          :title="expandedId === preset.id ? '收起条目' : '点开看这一块的全部条目'"
          @click="!picking && draggingKey === '' && emit('toggle-expand', preset)"
        >
          <span class="pe-item-name">
            <!-- 展开开关就摆在色点左边的小方块里：这是个动作，别做成一个看不见的符号 -->
            <span class="pe-caret" aria-hidden="true">{{ expandedId === preset.id ? '▾' : '▸' }}</span>
            <span class="pe-blk-color" :style="{ background: preset.color }" />
            <span class="pe-item-title">{{ preset.name }}</span>
            <span class="pe-item-cat" :class="{ off: preset.categoryId === '' }">{{ categoryLabel(preset) }}</span>
          </span>
          <span class="pe-item-meta">
            {{ MODE_LABEL[preset.mode] }} · {{ preset.itemCount }} 条 · {{ formatTime(preset.updatedAt) }}
          </span>
        </span>
        <!-- 展开才铺条目：摘要里只有前几条，展开时按 id 取整条（列表里没有全部条目） -->
        <span v-if="expandedId === preset.id" class="pe-item-tokens">
          <span v-if="expandBusy" class="pe-item-loading">正在读条目…</span>
          <template v-else>
            <span v-for="(item, at) in expandedItems" :key="`${at}-${item}`" class="pe-token">{{ item }}</span>
            <span v-if="expandedItems.length === 0" class="pe-item-loading">这一块没有条目。</span>
          </template>
        </span>
      </div>
      <div v-if="!picking" class="pe-item-actions">
        <button v-if="!editMode" class="pe-btn" :disabled="busyId !== ''" @click="emit('insert', preset)">插入</button>
        <!-- 删除要两步：库里这一份删了就没了（工作区那块不受影响） -->
        <template v-else-if="confirmRemoveId === preset.id">
          <button class="pe-btn pe-btn-danger" :disabled="busyId !== ''" @click="emit('submit-remove')">确认删除</button>
          <button class="pe-btn" @click="emit('cancel-remove')">取消</button>
        </template>
        <template v-else-if="renamingId === preset.id">
          <button
            class="pe-btn"
            :disabled="busyId !== '' || renameTo.trim() === ''"
            @click="emit('submit-rename')"
          >
            改名
          </button>
          <button class="pe-btn" @click="emit('cancel-rename')">取消</button>
        </template>
        <template v-else>
          <button class="pe-btn" :disabled="busyId !== ''" @click="emit('start-rename', preset)">改名</button>
          <button class="pe-btn pe-btn-danger" :disabled="busyId !== ''" @click="emit('ask-remove', preset)">删除</button>
        </template>
      </div>
    </li>
    <li v-if="presets.length === 0" class="pe-empty">
      {{ filtered ? '这个分类里还没有区块。' : '区块库还是空的 —— 在区块表头点「存」。' }}
    </li>
  </ul>
</template>

<style scoped src="./block-preset-list.css"></style>
