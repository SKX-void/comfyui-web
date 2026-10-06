/**
 * LoRA 目录浏览 + 预览图（WeiLin 原图太大，一律走服务端缩略图端点）。
 *
 * 抽出来是因为 LoraSelector.vue 一份组件管三件事（选择 / 目录浏览 / 触发词）。
 */
import { computed, ref } from 'vue';
import type { LoraFolderEntry, LoraListItem } from '@comfyui-web/shared';
import { api, apiUrl } from '@/api';

export function useLoraBrowser() {
// --- 目录浏览 ---
const currentPath = ref('');
const breadcrumbs = ref<Array<{ name: string; path: string }>>([{ name: '全部', path: '' }]);
const folders = ref<LoraFolderEntry[]>([]);
const items = ref<LoraListItem[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function open(path: string): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const r = await api.browseLoras(path);
    currentPath.value = r.path;
    breadcrumbs.value = r.breadcrumbs;
    folders.value = r.folders;
    items.value = r.items;
  } catch (err) {
    loadError.value = (err as Error).message;
    folders.value = [];
    items.value = [];
  } finally {
    loading.value = false;
  }
}
// --- 缩略图 ---
/**
 * 预览图走服务端缩略图端点：WeiLin 原图是 1~5MB，列表里直接加载不可行。
 *
 * 卡片用 3:4 竖版（LoRA 预览图多为竖构图，方形裁剪会丢画面）。
 * 尺寸按 2× 屏幕取，保证高分屏下清晰。
 * 无预览图的 LoRA 返回 204，浏览器触发 error → 显示占位块。
 */
function thumbUrl(file: string | undefined, w: number, h?: number): string {
  const q = new URLSearchParams({ file: file ?? '', w: String(w) });
  if (h !== undefined) q.set('h', String(h));
  return apiUrl(`/api/loras/thumb?${q.toString()}`);
}
const thumbFailed = ref<Record<string, boolean>>({});
function onThumbError(file: string): void {
  thumbFailed.value[file] = true;
}
// --- 文件管理器式的导航辅助 ---
/** 上一级目录；根目录时为 null */

const parentPath = computed(() => {
  const segs = currentPath.value ? currentPath.value.split('\\') : [];
  if (segs.length === 0) return null;
  return segs.slice(0, -1).join('\\');
});

/** 真·空目录：既没有子文件夹也没有 LoRA 文件 */
const isTrulyEmpty = computed(
  () => !loading.value && !loadError.value && folders.value.length === 0 && items.value.length === 0,
);

/** 只是没有文件，但有可进入的文件夹 */
const foldersOnly = computed(
  () => !loading.value && !loadError.value && folders.value.length > 0 && items.value.length === 0,
);

  return {
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
  };
}
