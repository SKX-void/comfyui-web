<script setup lang="ts">
/**
 * 区块库左栏：分类树（含「全部」与「未分类」两行固定的伪分类）。
 *
 * 只是展示 + 交互 —— 请求、busy、错误提示都在面板里（`BlockLibraryPanel.vue` 那套 run 外壳），
 * 这里只 emit 意图。管理动作（新建 / 改名 / 删确认）的中间状态也在面板：一次只做一件事，
 * 面板把要显示的那一件以 props 传下来，这里照画。
 *
 * **浏览模式下这棵树只是筛选器**（跟词库面板同一套）：不出现 ＋、不出现「改 / 删」、也不能拖 ——
 * 免得"只想找块"的人手一抖改了分类。
 *
 * 拖拽状态**就在本组件里**（不走 props）：`dragstart` 与紧接着的 `dragover` 之间没有父组件的
 * 往返时间，走 props 会把事件丢掉（`TagCategoryNav.vue` 同一个理由）。
 */
import { computed, ref, watch } from 'vue';

import type { BlockCategorySummary } from '../api';

const props = defineProps<{
  categories: BlockCategorySummary[];
  /** 选中的分类：`null` = 全部，`''` = 未分类 */
  active: string | null;
  total: number;
  /** 未分类的块数（后端单给：它不是一个分类，没有 id 也没有顺序） */
  uncategorized: number;
  busy: boolean;
  /** 编辑模式：关着时只筛选，不出现任何管理入口 */
  editMode: boolean;
  creating: boolean;
  newName: string;
  /** 待改名的分类 id（`''` = 没有） */
  renaming: string;
  renameTo: string;
  /** 待确认的删除：删分类会把里面的块变成未分类，所以先把影响范围摆出来 */
  confirm: { id: string; name: string; count: number } | null;
  /** 是不是正拖着**列表里的一行**（行拖到分类上 = 归类）—— 没在拖的时候这棵树不是落点 */
  dragging: boolean;
  /** 行正悬停在哪一行上：`''` = 未分类，`null` = 没有 */
  dropTarget: string | null;
}>();

const emit = defineEmits<{
  (e: 'pick', id: string | null): void;
  (e: 'start-create'): void;
  (e: 'cancel-create'): void;
  (e: 'update:newName', value: string): void;
  (e: 'submit-create'): void;
  (e: 'start-rename', category: BlockCategorySummary): void;
  (e: 'cancel-rename'): void;
  (e: 'update:renameTo', value: string): void;
  (e: 'submit-rename'): void;
  (e: 'ask-remove', category: BlockCategorySummary): void;
  (e: 'cancel-remove'): void;
  (e: 'submit-remove'): void;
  (e: 'reorder', ids: string[]): void;
  (e: 'drag-over', id: string): void;
  (e: 'drag-leave'): void;
  (e: 'drop', id: string): void;
}>();

const renamingName = computed(
  () => props.categories.find((one) => one.id === props.renaming)?.name ?? '',
);

const catDragId = ref('');
/** 落点：插到第 index 个分类**之前**；等于 categories.length 就是末尾 */
const catDropAt = ref(-1);

function start(id: string): void {
  catDragId.value = id;
  catDropAt.value = -1;
}

function end(): void {
  catDragId.value = '';
  catDropAt.value = -1;
}

/** 鼠标在行的下半部分 = 插到它后面（拿不到布局时一律当"插到前面"） */
function over(event: DragEvent, index: number): void {
  if (catDragId.value === '') return;
  const box = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.() ?? null;
  const after = box !== null && box.height > 0 && event.clientY > box.top + box.height / 2;
  catDropAt.value = after ? index + 1 : index;
}

function drop(): void {
  const moved = catDragId.value;
  const to = catDropAt.value;
  end();
  if (moved === '' || to < 0) return;
  const ids = props.categories.map((one) => one.id);
  const from = ids.indexOf(moved);
  if (from < 0) return;
  ids.splice(from, 1);
  // 摘掉自己之后，落点在它后面的要往前挪一格
  ids.splice(Math.max(0, Math.min(ids.length, to > from ? to - 1 : to)), 0, moved);
  // 位置没变就别写盘（拖了一下又放回原处是常事）
  if (ids.every((id, index) => id === props.categories[index]?.id)) return;
  emit('reorder', ids);
}

/**
 * 输入框出现时要**自己抢焦点**：不抢的话点了「＋」之后敲键盘什么也不会发生
 * （@keyup.enter / @keyup.esc 挂在输入框上，没焦点就永远不触发），看着就是"点了没反应"。
 */
const newInput = ref<HTMLInputElement | null>(null);
const renameInput = ref<HTMLInputElement | null>(null);
const grab = (target: typeof newInput): void => {
  target.value?.focus();
  target.value?.select();
};
// `flush: 'post'`：等 DOM 换完再抢焦点（默认的 pre 在渲染前跑，那时 ref 还是空的）
watch(
  () => props.creating,
  (on) => {
    if (on) grab(newInput);
  },
  { flush: 'post' },
);
watch(
  () => props.renaming,
  (id) => {
    if (id !== '') grab(renameInput);
  },
  { flush: 'post' },
);
</script>

<template>
  <aside class="pe-catnav">
    <div class="pe-catnav-head">
      <span>分类</span>
      <button
        v-if="editMode"
        class="pe-catnav-new"
        :disabled="busy || creating || renaming !== '' || confirm !== null"
        title="新建分类（可以重名）"
        @click="emit('start-create')"
      >
        ＋
      </button>
    </div>

    <!-- 管理区：一次只摆一件事（删确认 / 改名 / 新建），不然左栏会变成工具箱。
         三件事都没有时整块不渲染（不要留一个空盒子占着左栏） -->
    <div v-if="editMode && (confirm !== null || renaming !== '' || creating)" class="pe-catnav-manage">
      <template v-if="confirm !== null">
        <p class="pe-catnav-warn">
          删掉「{{ confirm.name }}」？<strong>{{ confirm.count }}</strong> 块会变成未分类（<strong>块本身不删</strong>）。
        </p>
        <span class="pe-catnav-btns">
          <button class="pe-btn pe-btn-danger" :disabled="busy" @click="emit('submit-remove')">确认删除</button>
          <button class="pe-btn" @click="emit('cancel-remove')">取消</button>
        </span>
      </template>
      <template v-else-if="renaming !== ''">
        <p class="pe-catnav-warn">把「{{ renamingName }}」改名成：</p>
        <input
          ref="renameInput"
          class="pe-input pe-catnav-input"
          :value="renameTo"
          @input="emit('update:renameTo', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('submit-rename')"
          @keyup.esc="emit('cancel-rename')"
        />
        <span class="pe-catnav-btns">
          <button class="pe-btn" :disabled="busy || renameTo.trim() === ''" @click="emit('submit-rename')">改名</button>
          <button class="pe-btn" @click="emit('cancel-rename')">取消</button>
        </span>
      </template>
      <template v-else-if="creating">
        <p class="pe-catnav-warn">新建分类（可以跟别的分类重名）：</p>
        <input
          ref="newInput"
          class="pe-input pe-catnav-input"
          :value="newName"
          placeholder="分类名"
          @input="emit('update:newName', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('submit-create')"
          @keyup.esc="emit('cancel-create')"
        />
        <span class="pe-catnav-btns">
          <button class="pe-btn" :disabled="busy || newName.trim() === ''" @click="emit('submit-create')">新建</button>
          <button class="pe-btn" @click="emit('cancel-create')">取消</button>
        </span>
      </template>
    </div>

    <ul class="pe-catnav-list">
      <li class="pe-catnav-row" :class="{ on: active === null }" @click="emit('pick', null)">
        <span class="pe-catnav-name">全部</span>
        <span class="pe-catnav-count">{{ total }}</span>
      </li>
      <!-- 「未分类」是**落点**（摘掉分类），「全部」不是：拖到"全部"上等于"去掉分类"太容易误触 -->
      <li
        class="pe-catnav-row"
        :class="{ on: active === '', 'pe-catnav-drop': dragging && dropTarget === '' }"
        :data-drop="dragging ? 'ok' : ''"
        @click="emit('pick', '')"
        @dragover.prevent="emit('drag-over', '')"
        @dragleave="emit('drag-leave')"
        @drop.prevent="emit('drop', '')"
      >
        <span class="pe-catnav-name">未分类</span>
        <span class="pe-catnav-count">{{ uncategorized }}</span>
      </li>
      <li
        v-for="(one, index) in categories"
        :key="one.id"
        class="pe-catnav-row"
        :class="{
          on: active === one.id,
          draggable: editMode,
          dragging: catDragId === one.id,
          'over-before': catDropAt === index,
          'over-after': catDropAt === index + 1,
          'pe-catnav-drop': dragging && dropTarget === one.id,
        }"
        :data-drop="dragging ? 'ok' : ''"
        :draggable="editMode ? 'true' : 'false'"
        @click="emit('pick', one.id)"
        @dragstart="start(one.id)"
        @dragend="end"
        @dragleave="emit('drag-leave')"
        @dragover.prevent="dragging ? emit('drag-over', one.id) : catDragId !== '' ? over($event, index) : undefined"
        @drop.prevent="catDragId !== '' ? drop() : emit('drop', one.id)"
      >
        <span class="pe-catnav-name" :title="one.name">{{ one.name }}</span>
        <span class="pe-catnav-count">{{ one.count }}</span>
        <span v-if="editMode" class="pe-catnav-ops">
          <button class="pe-catnav-op" :disabled="busy" title="改名" @click.stop="emit('start-rename', one)">改</button>
          <button class="pe-catnav-op" :disabled="busy" title="删除分类" @click.stop="emit('ask-remove', one)">删</button>
        </span>
      </li>
      <li v-if="categories.length === 0" class="pe-catnav-empty">
        {{ editMode ? '还没有分类，点上面的 ＋ 建一个。' : '还没有分类（「编辑模式」里能建）。' }}
      </li>
    </ul>
  </aside>
</template>

<style scoped src="./block-category-nav.css"></style>
