<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * 词库面板左边的分类树：全部 / 未分类 / 已有分类。
 *
 * 分类不是装饰 —— 它是"写作时怎么找词"的维度（见 server.js 的 queryTags 按 categories 分组）。
 *
 * 它同时是**拖拽的落点**：把右边某一行拖到某个分类上 = 那条改成这个分类。所以这批按钮
 * 要同时当"筛选用"（点）和"落点"（拖上去），两件事互不打扰。
 *
 * 「全部」**不是落点**（`''` 不是一个分类）：拖到它上面等于"去掉分类"就太容易误触了，
 * 想去掉分类拖「未分类」——那是个真状态。
 */
const props = defineProps<{
  categories: { name: string; count: number }[];
  total: number;
  uncategorized: number;
  /** 当前选中的分类名（`''` = 全部，`__none__` = 未分类） */
  active: string;
  /** 是不是正拖着某一行（拖拽状态在父级）—— 没在拖的时候落点不该有反应 */
  dragging: boolean;
  /** 正被悬停的落点（`''` = 没有；`__none__` = 未分类） */
  dropTarget: string;
  /** 分类级管理（分类本身是一张表）：新建 / 改名 / 删除三件事的中间状态 */
  creating: boolean;
  newName: string;
  renaming: string;
  renameTo: string;
  /** 待确认的删除：删分类会连带摘掉它下面所有归属，所以先摆出影响范围 */
  confirm: { name: string; count: number } | null;
  busy: boolean;
  /** 面板的编辑模式：关着时这棵树只是筛选 + 拖拽落点，不出现任何管理入口 */
  editMode: boolean;
  /** 待确认的"批量删掉这个分类下的词条"（词条真删，分类留着） */
  deleteConfirm: { name: string; count: number } | null;
}>();
const emit = defineEmits<{
  (e: 'pick', name: string): void;
  (e: 'drag-over', name: string): void;
  (e: 'drag-leave'): void;
  (e: 'drop', name: string): void;
  (e: 'start-create'): void;
  (e: 'cancel-create'): void;
  (e: 'update:newName', value: string): void;
  (e: 'submit-create'): void;
  (e: 'start-rename', name: string): void;
  (e: 'cancel-rename'): void;
  (e: 'update:renameTo', value: string): void;
  (e: 'submit-rename'): void;
  (e: 'ask-remove', name: string, count: number): void;
  (e: 'cancel-remove'): void;
  (e: 'submit-remove'): void;
  (e: 'reorder-categories', names: string[], moved: string): void;
  (e: 'ask-delete-entries', name: string, count: number): void;
  (e: 'cancel-delete-entries'): void;
  (e: 'submit-delete-entries'): void;
}>();

/**
 * 分类拖拽的状态**就在这个组件里**（不走父组件 props）：dragstart 和紧接着的 dragover
 * 必须是同步可见的，绕一趟 props 会慢一拍 —— 那一下落点就是错的（真实浏览器里够快，
 * 但没有任何理由把正确性押在"两件事之间恰好渲染了一帧"上）。
 */
const dragName = ref('');
const dropAt = ref(-1);

function startDrag(name: string): void {
  dragName.value = name;
  dropAt.value = -1;
}

/** 落在某一行上/下半边 = 插到它前面/后面；拿不到布局时（测试里 rect 全是 0）一律当"插到前面" */
function overRow(index: number, event: DragEvent): void {
  if (dragName.value === '') return;
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.() ?? null;
  const after = rect !== null && rect.height > 0 && event.clientY > rect.top + rect.height / 2;
  dropAt.value = after ? index + 1 : index;
}

function dropRow(): void {
  const dragged = dragName.value;
  const to = dropAt.value;
  dragName.value = '';
  dropAt.value = -1;
  if (dragged === '' || to < 0) return;
  const names = props.categories.map((one) => one.name);
  const from = names.indexOf(dragged);
  if (from < 0) return;
  const at = to > from ? to - 1 : to;
  if (at === from) return; // 拖回原位 = 没动，不发请求
  names.splice(from, 1);
  names.splice(at, 0, dragged);
  emit('reorder-categories', names, dragged);
}

/**
 * 输入框出现时要**自己抢焦点**：不抢的话点了「改」之后敲键盘什么也不会发生
 * （`@keyup.enter` / `@keyup.esc` 挂在输入框上，没焦点就永远不触发），
 * 看起来就是"点了没反应、也没法取消"。
 */
const newInput = ref<HTMLInputElement | null>(null);
const renameInput = ref<HTMLInputElement | null>(null);
const grab = (target: typeof newInput): void => {
  target.value?.focus();
  target.value?.select();
};
// `flush: 'post'`：等 DOM 换完再抢焦点（默认的 pre 在渲染前跑，那时 ref 还是空的；
// 而自己在回调里 `await nextTick()` 又会慢一拍 —— 就是"点了没反应"的来源）
watch(() => props.creating, (on) => { if (on) grab(newInput); }, { flush: 'post' });
watch(() => props.renaming, (name) => { if (name !== '') grab(renameInput); }, { flush: 'post' });
</script>

<template>
  <nav class="pe-lib-cats" :class="{ 'pe-lib-cats-dragging': dragging }">
    <!-- 分类级管理区：一次只显示一件事（新建 / 改名 / 删除确认），不然左边会变成工具箱。
         整个区跟「改 / 删」一样只在编辑模式出现 —— 浏览模式下这棵树不该有写入口 -->
    <div v-if="editMode" class="pe-lib-cat-manage">
      <template v-if="deleteConfirm !== null">
        <p class="pe-lib-cat-warn">
          把「{{ deleteConfirm.name }}」下的 <strong>{{ deleteConfirm.count }}</strong> 条词条<strong>从词库里删掉</strong>？<br />
          删了就没了（不可撤销，手改过的也一样删）。<strong>分类本身留着</strong>，变成一个空分类。
        </p>
        <span class="pe-lib-cat-btns">
          <button class="pe-btn pe-btn-danger" :disabled="busy" @click="emit('submit-delete-entries')">确认删除</button>
          <button class="pe-btn" @click="emit('cancel-delete-entries')">取消</button>
        </span>
      </template>
      <template v-else-if="confirm !== null">
        <p class="pe-lib-cat-warn">
          删掉「{{ confirm.name }}」？<br />
          <strong>{{ confirm.count }}</strong> 条词条会变回未分类（<strong>词条本身不删</strong>）。
        </p>
        <span class="pe-lib-cat-btns">
          <button class="pe-btn pe-btn-danger" :disabled="busy" @click="emit('submit-remove')">确认删除</button>
          <button class="pe-btn" @click="emit('cancel-remove')">取消</button>
        </span>
      </template>
      <template v-else-if="renaming !== ''">
        <p class="pe-lib-cat-warn">把「{{ renaming }}」改名成：</p>
        <input
          ref="renameInput"
          class="pe-input pe-lib-cat-input"
          :value="renameTo"
          @input="emit('update:renameTo', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('submit-rename')"
          @keyup.esc="emit('cancel-rename')"
        />
        <span class="pe-lib-cat-btns">
          <button class="pe-btn" :disabled="busy || renameTo.trim() === ''" @click="emit('submit-rename')">改名</button>
          <button class="pe-btn" @click="emit('cancel-rename')">取消</button>
        </span>
      </template>
      <template v-else-if="creating">
        <input
          ref="newInput"
          class="pe-input pe-lib-cat-input"
          :value="newName"
          placeholder="新分类名"
          @input="emit('update:newName', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('submit-create')"
          @keyup.esc="emit('cancel-create')"
        />
        <span class="pe-lib-cat-btns">
          <button class="pe-btn" :disabled="busy || newName.trim() === ''" @click="emit('submit-create')">新建</button>
          <button class="pe-btn" @click="emit('cancel-create')">取消</button>
        </span>
      </template>
      <button v-else class="pe-btn pe-btn-quiet pe-lib-cat-new" @click="emit('start-create')">＋ 新建分类</button>
    </div>

    <button :class="{ on: active === '' }" @click="emit('pick', '')">
      全部 <em>{{ total }}</em>
    </button>
    <button
      :class="{ on: active === '__none__', 'pe-lib-drop-on': dragging && dropTarget === '__none__' }"
      :data-drop="dragging ? 'ok' : ''"
      @click="emit('pick', '__none__')"
      @dragover.prevent="emit('drag-over', '__none__')"
      @dragleave="emit('drag-leave')"
      @drop.prevent="emit('drop', '__none__')"
    >
      未分类 <em>{{ uncategorized }}</em>
    </button>
    <!-- 一行 = 一个分类：可点的那个是「选它」（也当落点），改名/删除挂在它旁边（button 里不能再套 button） -->
    <div
      v-for="(one, index) in categories"
      :key="one.name"
      class="pe-lib-cat-row"
      :class="{
        'pe-lib-cat-row-editing': renaming === one.name,
        'pe-lib-cat-row-dragging': dragName === one.name,
        'pe-lib-cat-row-over-before': dragName !== '' && dropAt === index,
        'pe-lib-cat-row-over-after': dragName !== '' && dropAt === index + 1,
      }"
      :draggable="true"
      @dragstart="startDrag(one.name)"
      @dragend="
        () => {
          dragName = '';
          dropAt = -1;
        }
      "
      @dragover.prevent="
        dragging ? emit('drag-over', one.name) : dragName !== '' ? overRow(index, $event) : undefined
      "
      @dragleave="emit('drag-leave')"
      @drop.prevent="dragName !== '' ? dropRow() : emit('drop', one.name)"
    >
      <!-- 跟 tag 行同一个六点手柄（内联 SVG）：告诉人"这行能拖"。分类行同样整行可拖 -->
      <span class="pe-lib-grip" title="拖动调整分类顺序" aria-hidden="true">
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2" cy="3" r="1.4" />
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="2" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="2" cy="13" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </span>
      <button
        class="pe-lib-cat-pick"
        :class="{ on: active === one.name, 'pe-lib-drop-on': dragging && dropTarget === one.name }"
        :data-drop="dragging ? 'ok' : ''"
        :title="one.name"
        @click="emit('pick', one.name)"
      >
        <span class="pe-lib-cat-name">{{ one.name }}</span> <em>{{ one.count }}</em>
      </button>
      <span v-if="editMode" class="pe-lib-cat-tools">
        <button class="pe-lib-cat-tool" title="改名" @click="emit('start-rename', one.name)">改</button>
        <button
          class="pe-lib-cat-tool"
          title="批量删掉这个分类下的词条（分类留着）"
          @click="emit('ask-delete-entries', one.name, one.count)"
        >
          清
        </button>
        <button class="pe-lib-cat-tool" title="删掉这个分类" @click="emit('ask-remove', one.name, one.count)">删</button>
      </span>
    </div>
    <p v-if="categories.length === 0" class="pe-lib-tip">
      还没有分类。<br />点上面的「＋ 新建分类」建一个，或把右边的条目拖到「未分类」以外的地方。
    </p>
  </nav>
</template>

<style scoped src="./tag-category-nav.css"></style>
