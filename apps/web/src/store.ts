import { computed, ref } from 'vue';
import { getJSON, putJSON } from './api';
import type { HostInfo, PluginInfo, TabEntry, UiPrefs } from './types';

/** tab 栏内容：来自已成功加载的插件前端入口（**自然顺序**：清单 order,id） */
export const tabs = ref<TabEntry[]>([]);
/** 完整清单：设置页用 */
export const plugins = ref<PluginInfo[]>([]);
export const hostInfo = ref<HostInfo | null>(null);

/**
 * 清单本身加载失败的原因（后端 500 / 网络不通 / 返回不是 JSON）。
 *
 * 必须单独存一份并**在界面上显示**：拿不到清单时 tab 栏会是空的，
 * 看起来和"一个插件都没装"一模一样 —— 静默残缺比报错难查得多。
 * 这正是 v1 用 `fatalError` 横幅防过的坑。
 */
export const manifestError = ref<string | null>(null);

// ---- 外壳偏好：标签栏顺序 + 默认首页 ------------------------------------

/** 后端 `<dataDir>/host.json` 偏好段的镜像；读不到时保持默认值 */
export const uiPrefs = ref<UiPrefs>({
  tabOrder: [],
  home: null,
  globals: { comfyuiBaseUrl: '' },
  following: [],
});

/**
 * 读外壳偏好。**读失败不算错误**：偏好只决定"顺序和落点"，
 * 拿不到就按默认走（清单顺序 + 第一个可用 tab），不该把整个外壳一起拖下水。
 */
export async function fetchUiPrefs(): Promise<void> {
  try {
    const data = await getJSON<{ prefs: UiPrefs }>('/api/ui');
    const prefs = data.prefs;
    uiPrefs.value = {
      tabOrder: Array.isArray(prefs?.tabOrder) ? prefs.tabOrder : [],
      home: typeof prefs?.home === 'string' && prefs.home !== '' ? prefs.home : null,
      // 宿主全局设置：拿不到就是空（= 不统一），不该把外壳一起拖下水
      globals: {
        comfyuiBaseUrl:
          typeof prefs?.globals?.comfyuiBaseUrl === 'string' ? prefs.globals.comfyuiBaseUrl : '',
      },
      following: Array.isArray(prefs?.following) ? prefs.following : [],
    };
  } catch (err) {
    console.warn('[host] 读取外壳偏好失败，按默认处理：', err);
    uiPrefs.value = { tabOrder: [], home: null, globals: { comfyuiBaseUrl: '' }, following: [] };
  }
}

/**
 * 写偏好：后端返回**清洗后**的值，用它回填，保证界面显示的就是真存下来的那份。
 *
 * 统一 ComfyUI 地址这类全局设置会影响插件：后端保存后立刻重算兜底补丁，并把
 * "跟随它的插件"回报回来（`following`），设置页据此说清楚刚刚发生了什么。
 */
export async function saveUiPrefs(
  next: UiPrefs,
): Promise<{ following: string[]; warning?: string }> {
  const data = await putJSON<{ prefs: UiPrefs; following?: string[]; warning?: string }>(
    '/api/ui',
    next,
  );
  uiPrefs.value = data.prefs;
  return {
    following: Array.isArray(data.following) ? data.following : [],
    ...(data.warning !== undefined ? { warning: data.warning } : {}),
  };
}

/**
 * 按偏好重排：偏好里点过名的按偏好顺序排前面，其余的保持原顺序跟在后面。
 *
 * 这是**过滤 + 补齐**，不是"整体覆盖"：偏好里存着已卸载插件的 id 也不会出问题，
 * 少列的插件只是回到默认位置 —— 所以偏好过期/损坏都不会让 tab 栏缺项。
 */
export function orderTabs<T extends { id: string }>(items: T[], tabOrder: string[]): T[] {
  const rank = new Map(tabOrder.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0; // 都没点过名：保持传入顺序（Array.sort 是稳定的）
  });
}

/** tab 栏的实际顺序（响应式）：设置页改完顺序，顶栏不用刷新就跟上 */
export const orderedTabs = computed(() => orderTabs(tabs.value, uiPrefs.value.tabOrder));

/**
 * 默认首页的**回退链**（根路由与设置页共用，保证两处口径一致）：
 *   偏好里的 home（且当前真有这个 tab、且它没坏）
 *   → 第一个没坏的 tab
 *   → 第一个 tab（哪怕坏了：至少把失败原因摆出来，比白屏强）
 *   → null（一个 tab 都没有：留在欢迎页）
 */
export function resolveHome(list: TabEntry[], preferred: string | null): TabEntry | null {
  if (preferred !== null) {
    const wanted = list.find((tab) => tab.id === preferred);
    if (wanted !== undefined && wanted.error === undefined) return wanted;
  }
  return list.find((tab) => tab.error === undefined) ?? list[0] ?? null;
}

export async function fetchPlugins(): Promise<PluginInfo[]> {
  const data = await getJSON<{ plugins: PluginInfo[] }>('/api/plugins');
  plugins.value = data.plugins;
  return data.plugins;
}

export async function fetchHostInfo(): Promise<void> {
  hostInfo.value = await getJSON<HostInfo>('/api/host');
}
