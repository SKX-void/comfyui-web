<script setup lang="ts">
/**
 * 词库面板里的一行：看（原文/译文/分类/别名 + 插入/改/删）或改（译文/分类/别名表单）。
 *
 * 单独成文件只是为了行数：`form` 就是父级那个 ref 里的对象，这里 v-model 直接改它的字段
 * （保存时父级读到的就是这里改过的值）。
 *
 * 分类有三条路，各管一段（**一个 tag 只属于一个分类**，库里 134346 行全是单分类）：
 * - **把行拖到左边分类上 = 换成那一个**（最快，日常走这条）
 * - 行上分类标签的「×」= 摘掉它；编辑态里点标签 = 加/减（精确，攒多分类也走这条）
 * - 编辑态的输入框 = 批量改 / **造一个全新的分类名**（拖拽的落点只存在于已有名字里）
 */
import type { TagEntry } from '../api';

const props = defineProps<{
  entry: TagEntry;
  /** 可插入的目标块数：一个都没有时「插入」不可点 */
  targetCount: number;
  editing: boolean;
  busy: boolean;
  form: { zh: string; categories: string; aliases: string };
  /** 这一行是不是正被拖着（拖拽状态在父级，见 useTagLibrary 的 dragKey） */
  dragging: boolean;
  /** 插入位置：`0..n`，`-1` = 没有（`insertBefore` = 插到本行前面，`insertAfter` = 后面） */
  dropIndex: number;
  /** 本行在列表里的序号（算落点用） */
  index: number;
  /** 这一页能不能拖顺序（只在「全部」且没搜索时为真；筛选态下拖行不排序，只认左边分类） */
  sortable: boolean;
  /** 编辑态里用来点着加/减的那批名字（就是左边分类树） */
  knownCategories: string[];
  /** 面板的编辑模式：关着的时候行上不出现「改 / 删 / 摘分类」（它们紧挨着「插入」，最容易误触） */
  editMode: boolean;
}>();
const emit = defineEmits<{
  (e: 'insert', entry: TagEntry): void;
  (e: 'start-edit', entry: TagEntry): void;
  (e: 'remove', entry: TagEntry): void;
  (e: 'save', entry: TagEntry): void;
  (e: 'cancel'): void;
  (e: 'drag-start', entry: TagEntry): void;
  (e: 'drag-end'): void;
  (e: 'row-drag-over', index: number, event: DragEvent): void;
  (e: 'row-drop'): void;
  (e: 'toggle-category', name: string): void;
  (e: 'remove-category', name: string): void;
}>();

/** 编辑态里那个标签是不是已经在输入框里了（画选中态）。拆法跟 useTagLibrary 的 splitList 一致 */
function picked(name: string): boolean {
  return (props.form.categories ?? '')
    .split(/[,，]/)
    .map((one) => one.trim())
    .filter((one) => one !== '')
    .includes(name);
}

/** 热度只用来排序，显示成 8.4M / 12k / 340 这样的短标签（导入数据是 danbooru 的 post count） */
function hotLabel(hot: number): string {
  if (hot >= 1_000_000) return `${(hot / 1_000_000).toFixed(1)}M`;
  if (hot >= 1_000) return `${Math.round(hot / 1_000)}k`;
  return String(hot);
}
</script>

<template>
  <div
    class="pe-lib-row"
    :class="{
      'pe-lib-row-dragging': dragging,
      'pe-lib-row-over-before': dropIndex === index,
      'pe-lib-row-over-after': dropIndex === index + 1,
    }"
  >
    <div
      v-if="!editing"
      class="pe-lib-line"
      :draggable="true"
      @dragstart="emit('drag-start', entry)"
      @dragend="emit('drag-end')"
      @dragover.prevent="sortable && emit('row-drag-over', index, $event)"
      @drop.prevent="sortable && emit('row-drop')"
    >
      <!-- 六点手柄：告诉人"这行能拖"。**行本身也能拖**，手柄只是把这件事说出来 -->
      <span
        class="pe-lib-grip"
        :title="sortable ? '拖动排序；拖到左边分类上 = 换分类' : '拖到左边分类上 = 换分类（排序只在「全部」且没搜索时可用）'"
        aria-hidden="true"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2" cy="3" r="1.4" />
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="2" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="2" cy="13" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </span>
      <span class="pe-lib-en">{{ entry.en }}</span>
      <span v-if="entry.hot > 0" class="pe-lib-hot" title="热度：导入数据的 post count，面板按它排序">{{ hotLabel(entry.hot) }}</span>
      <span class="pe-lib-zh">{{ entry.zh }}</span>
      <span class="pe-lib-src">库</span>
      <span v-for="name in entry.categories" :key="name" class="pe-lib-cat">
        {{ name }}
        <!-- 拖拽答不了"减"：摘掉一个分类就在这儿点一下（也是"改内容"，所以跟「改」一起收进编辑模式） -->
        <button v-if="editMode" class="pe-lib-cat-x" :disabled="busy" title="去掉这个分类" @click="emit('remove-category', name)">×</button>
      </span>
      <span v-for="alias in entry.aliases" :key="alias" class="pe-lib-alias">= {{ alias }}</span>
      <span class="pe-lib-actions">
        <!-- 插入和编辑互斥：编辑模式下行上只留"改这条"的动作 -->
        <button v-if="!editMode" class="pe-btn" :disabled="targetCount === 0" @click="emit('insert', entry)">插入</button>
        <template v-else>
          <button class="pe-btn" @click="emit('start-edit', entry)">改</button>
          <button class="pe-btn pe-btn-danger" :disabled="busy" @click="emit('remove', entry)">删</button>
        </template>
      </span>
    </div>

    <div v-else class="pe-lib-edit">
      <!-- 改的时候必须看得见在改哪个词（之前一进编辑态原词就没了） -->
      <div class="pe-lib-edit-head">
        <span class="pe-lib-en">{{ entry.en }}</span>
        <span class="pe-lib-src">库</span>
      </div>
      <label>译文<input v-model="form.zh" class="pe-input" /></label>
      <div class="pe-lib-edit-cats">
        <span class="pe-lib-edit-label">分类</span>
        <!-- 点一下就加/减：精确那条路（想同时属于两个就点两个） -->
        <button
          v-for="name in knownCategories"
          :key="name"
          class="pe-lib-cat pe-lib-cat-pick"
          :class="{ on: picked(name) }"
          @click="emit('toggle-category', name)"
        >
          {{ name }}
        </button>
        <!-- 输入框还在：批量改、以及造一个全新的分类名（拖拽/点标签都造不出来） -->
        <input v-model="form.categories" class="pe-input" placeholder="逗号分隔，如 画质, 光照" />
      </div>
      <label>别名<input v-model="form.aliases" class="pe-input" placeholder="逗号分隔：输入别名也能命中正名" /></label>
      <div class="pe-lib-actions">
        <button class="pe-btn" :disabled="busy" @click="emit('save', entry)">保存</button>
        <button class="pe-btn" @click="emit('cancel')">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./tag-library-row.css"></style>
