/**
 * 库面板的「多选 + 导入导出」：选择集、全选、下载、读文件 —— 预设库与区块库共用这一套。
 *
 * 两边的数据与接口完全不同，共用的只有这几个动作，所以这里只认三个钩子（导出 / 导入 / 文件名前缀），
 * 不碰任何一份库的形状。错误与提示写回**面板自己的** `error` / `hint`（两个面板本来就有一套，
 * 再养一套就有两个地方要显示"出错了"）。
 *
 * 选择集用数组不用 Set：面板要按它给每一行画勾，数组的 `includes` 在几十~几百条上没有任何问题，
 * 换来的是"改了就一定重渲染"这件事不用再想。
 */
import { computed, ref, type Ref } from 'vue';

import { downloadJson, readJsonFile, stamp } from '../download';

export function useImportExport(hooks: {
  error: Ref<string>;
  hint: Ref<string>;
  /** 下载文件名前缀：`预设库-20250101-1200.json` */
  label: string;
  /** 选中的 id → 服务端那份导出文件（原样下载，形状不在这边拼） */
  exportFile: (ids: string[]) => Promise<unknown>;
  /** 用户挑的文件 → 服务端导入，返回一句回执（导了几条、跳了几条） */
  importFile: (data: unknown) => Promise<string>;
}) {
  /** 多选模式：默认关 —— 平时行上是载入 / 插入，多选是另一件事，不该天天摆在那儿 */
  const on = ref(false);
  const picked = ref<string[]>([]);
  const busy = ref(false);

  const count = computed(() => picked.value.length);
  const isPicked = (id: string): boolean => picked.value.includes(id);

  /** 当前列表是否已全选。「全选」作用于**看得见的这些**（筛过的视图里就是这一堆） */
  const allPicked = (ids: string[]): boolean => ids.length > 0 && ids.every((id) => picked.value.includes(id));

  function start(): void {
    on.value = true;
  }

  function stop(): void {
    on.value = false;
    picked.value = [];
  }

  function toggle(id: string): void {
    picked.value = isPicked(id) ? picked.value.filter((one) => one !== id) : [...picked.value, id];
  }

  function toggleAll(ids: string[]): void {
    const all = allPicked(ids);
    picked.value = all
      ? picked.value.filter((id) => !ids.includes(id))
      : [...picked.value, ...ids.filter((id) => !picked.value.includes(id))];
  }

  /** 统一 busy / 错误 / 提示：跟两个面板自己的 `run` 一个路子，只是不需要调用方传"成功文案" */
  async function guard(action: () => Promise<void>): Promise<void> {
    busy.value = true;
    hooks.error.value = '';
    hooks.hint.value = '';
    try {
      await action();
    } catch (err) {
      hooks.error.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  }

  async function exportPicked(): Promise<void> {
    const ids = [...picked.value];
    if (ids.length === 0) return;
    await guard(async () => {
      downloadJson(`${hooks.label}-${stamp()}.json`, await hooks.exportFile(ids));
      hooks.hint.value = `已导出 ${ids.length} 条`;
    });
  }

  /**
   * 文件框的 change：选完就把 `value` 清掉 —— 不清的话同一个文件再选一次不会触发 change，
   * 看着就是"点了没反应"（导第二次想覆盖时最容易撞上）。
   */
  async function onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file === null) return;
    await guard(async () => {
      hooks.hint.value = await hooks.importFile(await readJsonFile(file));
    });
  }

  return { on, picked, busy, count, isPicked, allPicked, start, stop, toggle, toggleAll, exportPicked, onFilePicked };
}
