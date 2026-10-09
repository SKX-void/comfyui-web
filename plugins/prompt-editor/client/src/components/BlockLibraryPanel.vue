<script setup lang="ts">
/**
 * 区块库面板：**预设单块**的库（跟「预设库」那份整份文档不是一回事）。
 *
 * 来源是区块表头的「存」—— 点了会把那一块的快照（标题/颜色/风格/条目文本）送到这里，
 * 面板打开并给出"给它起个名字"的输入框（**自动抢焦点**：不抢的话回车存不了、用户会以为点了没反应）。
 *
 * 插入 = **新增一块、追加到最后**（不动任何已有区块）。条目译文不带：库里那份可能已经过期，
 * 插进来按当前词库重新查才对。
 *
 * **浏览 / 编辑两种模式**（跟词库面板同一套）：浏览模式只插不改；编辑模式才显示拖拽手柄、
 * 改名 / 删除，左栏才有建 / 改 / 删分类。每次打开面板都退回浏览模式 —— 管理动作不该跟着面板一起记住。
 *
 * 状态与请求都在 `composables/useBlockLibrary.ts`（这里只管画与几个 DOM 细节）。
 */
import { computed, ref, watch } from 'vue';

import type { BlockPreset } from '../api';
import { useBlockLibrary, type PendingBlock } from '../composables/useBlockLibrary';
import BlockCategoryNav from './BlockCategoryNav.vue';
import BlockPresetList from './BlockPresetList.vue';

const props = defineProps<{ open: boolean; pending: PendingBlock | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'insert', preset: BlockPreset): void; (e: 'cancel-pending'): void }>();

const {
  presets,
  categories,
  uncategorized,
  activeCat,
  saveCategoryId,
  name,
  busyId,
  error,
  hint,
  presetRenameId,
  presetRenameTo,
  presetRemoveId,
  expandedId,
  expandedItems,
  expandBusy,
  editMode,
  creatingCategory,
  newCategory,
  renamingCategory,
  renameTo,
  confirmRemove,
  visible,
  dragKey,
  dropTarget,
  dropIndex,
  sortable,
  refresh,
  save,
  insert,
  move,
  toggleExpand,
  startRename,
  cancelRename,
  submitRename,
  askRemove,
  cancelRemove,
  submitRemove,
  startCreateCategory,
  cancelCreateCategory,
  submitCreateCategory,
  startRenameCategory,
  cancelRenameCategory,
  submitRenameCategory,
  askRemoveCategory,
  cancelRemoveCategory,
  submitRemoveCategory,
  exitEditMode,
  toggleEditMode,
  reorderCategories,
  onRowDragStart,
  onDragEnd,
  onDragLeave,
  onDragOverCategory,
  onDropOnCategory,
  onRowDragOver,
  onRowDrop,
  transfer: {
    on: picking,
    picked: pickedIds,
    busy: transferBusy,
    count: pickedCount,
    allPicked,
    start: startPick,
    stop: stopPick,
    toggle: togglePick,
    toggleAll: toggleAllPick,
    exportPicked,
    onFilePicked,
  },
} = useBlockLibrary({
  insert: (preset) => emit('insert', preset),
  consumePending: () => emit('cancel-pending'),
});

/** 存块时那个名字框：打开面板（或又送来一块）要**自己抢焦点** */
const nameBox = ref<HTMLInputElement | null>(null);

/** 原生 `<input type=file>` 藏起来，由「导入…」按钮去点它 */
const fileBox = ref<HTMLInputElement | null>(null);

/** 全选的对象：当前列表（左栏筛着某个分类时，就是这一堆） */
const visibleIds = computed(() => visible.value.map((one) => one.id));

/** 存块那一行显示"会存到哪一堆"：左栏选中的分类名（「全部 / 未分类」= 未分类） */
const saveCatLabel = computed(
  () => categories.value.find((one) => one.id === saveCategoryId.value)?.name ?? '未分类',
);

/**
 * 打开面板（或又送来一块）→ 重新拉列表；带着块来的话把名字框填上并抢焦点。
 *
 * `flush: 'post'`：默认的 pre 时机里 `nameBox` 还是空的，抢焦点会静默失效
 * （分类改名那个 bug 就是这么来的）。每次打开都退回浏览模式：管理动作不跟着面板记住。
 */
let wasOpen = false;
watch(
  () => [props.open, props.pending] as const,
  ([open, pending]) => {
    if (!open) {
      wasOpen = false;
      return;
    }
    // 退回浏览模式只认"打开"这一下：面板已经开着的时候又送来一块（只可能是脚本/快速连点），
    // 不该顺手把人正在用的编辑模式关掉
    if (!wasOpen) exitEditMode();
    wasOpen = true;
    error.value = '';
    hint.value = '';
    void refresh();
    if (pending === null) return;
    name.value = pending.title.trim();
    nameBox.value?.focus();
  },
  { flush: 'post' },
);
</script>

<template>
  <div v-if="open" class="pe-overlay" @click.self="emit('close')">
    <div class="pe-panel">
      <header class="pe-panel-head">
        <strong>区块库</strong>
        <span class="pe-blk-stat">{{ presets.length }} 块 · {{ categories.length }} 个分类</span>
        <!-- 导入是**写**动作：跟改名 / 删除一样只在编辑模式露出来 -->
        <button v-if="editMode" class="pe-btn" :disabled="transferBusy" @click="fileBox?.click()">导入…</button>
        <button
          class="pe-btn"
          :class="{ on: picking }"
          :disabled="transferBusy"
          title="多选：挑几块一起导出（导出是只读的，浏览模式也能用）"
          @click="picking ? stopPick() : startPick()"
        >
          {{ picking ? '退出多选' : '多选' }}
        </button>
        <button
          class="pe-btn pe-blk-mode"
          :class="{ on: editMode }"
          :title="editMode ? '编辑模式：行上是归类 / 改名 / 删除，左栏能建 / 改 / 删分类' : '浏览模式：只插不改；打开才会出现管理入口'"
          @click="toggleEditMode"
        >
          {{ editMode ? '编辑模式：开' : '编辑模式：关' }}
        </button>
        <button class="pe-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <input ref="fileBox" class="pe-file" type="file" accept=".json,application/json" @change="onFilePicked" />

      <div class="pe-blk-bar">
        <!-- 多选时这一栏换成选择条：这会儿不是在存块，是在挑要导出的块 -->
        <div v-if="picking" class="pe-selbar">
          <label class="pe-pick-all">
            <input type="checkbox" class="pe-pick" :checked="allPicked(visibleIds)" @change="toggleAllPick(visibleIds)" />
            <span>全选</span>
          </label>
          <span class="pe-sel-count">已选 {{ pickedCount }} / {{ visible.length }}</span>
          <button class="pe-btn" :disabled="pickedCount === 0 || transferBusy" @click="exportPicked">导出选中</button>
          <button class="pe-btn" :disabled="transferBusy" @click="stopPick">取消</button>
        </div>
        <div v-else-if="pending !== null" class="pe-blk-save">
          <input
            ref="nameBox"
            v-model="name"
            class="pe-input"
            placeholder="给它起个名字（存进区块库）"
            @keydown.enter="save(pending)"
            @keydown.esc="emit('cancel-pending')"
          />
          <!-- 归到哪儿不在这儿选：左栏选着谁就归谁（拖不进来的一块，没地方落） -->
          <span class="pe-blk-target">存到：{{ saveCatLabel }}</span>
          <button class="pe-btn" @click="save(pending)">存</button>
          <button class="pe-btn" @click="emit('cancel-pending')">取消</button>
        </div>
        <span v-else class="pe-blk-tip">在区块表头点「存」把一块存进来。</span>
      </div>

      <div class="pe-blk-body">
        <BlockCategoryNav
          :categories="categories"
          :active="activeCat"
          :total="presets.length"
          :uncategorized="uncategorized"
          :busy="busyId !== ''"
          :edit-mode="editMode"
          :creating="creatingCategory"
          :new-name="newCategory"
          :renaming="renamingCategory"
          :rename-to="renameTo"
          :confirm="confirmRemove"
          :dragging="dragKey !== ''"
          :drop-target="dropTarget"
          @pick="activeCat = $event"
          @start-create="startCreateCategory"
          @cancel-create="cancelCreateCategory"
          @update:new-name="(value: string) => (newCategory = value)"
          @submit-create="submitCreateCategory"
          @start-rename="startRenameCategory"
          @cancel-rename="cancelRenameCategory"
          @update:rename-to="(value: string) => (renameTo = value)"
          @submit-rename="submitRenameCategory"
          @ask-remove="askRemoveCategory"
          @cancel-remove="cancelRemoveCategory"
          @submit-remove="submitRemoveCategory"
          @reorder="reorderCategories"
          @drag-over="onDragOverCategory"
          @drag-leave="onDragLeave"
          @drop="onDropOnCategory"
        />
        <BlockPresetList
          :presets="visible"
          :categories="categories"
          :busy-id="busyId"
          :filtered="activeCat !== null"
          :edit-mode="editMode"
          :picking="picking"
          :picked-ids="pickedIds"
          :dragging-key="dragKey"
          :drop-index="dropIndex"
          :sortable="sortable"
          :renaming-id="presetRenameId"
          :rename-to="presetRenameTo"
          :confirm-remove-id="presetRemoveId"
          :expanded-id="expandedId"
          :expanded-items="expandedItems"
          :expand-busy="expandBusy"
          @insert="insert"
          @toggle-pick="togglePick"
          @toggle-expand="toggleExpand"
          @start-rename="startRename"
          @cancel-rename="cancelRename"
          @update:rename-to="(value: string) => (presetRenameTo = value)"
          @submit-rename="submitRename"
          @ask-remove="askRemove"
          @cancel-remove="cancelRemove"
          @submit-remove="submitRemove"
          @drag-start="onRowDragStart"
          @drag-end="onDragEnd"
          @row-drag-over="onRowDragOver"
          @row-drop="onRowDrop"
        />
      </div>

      <footer class="pe-blk-foot">
        <span v-if="error !== ''" class="pe-error">{{ error }}</span>
        <span v-else-if="hint !== ''" class="pe-hint">{{ hint }}</span>
        <span v-else class="pe-blk-note">插入 = 新增一块、追加到最后；条目按当前词库重新查译文，库里不存译文。</span>
      </footer>
    </div>
  </div>
</template>

<style scoped src="./block-library-panel.css"></style>
