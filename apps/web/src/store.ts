import { computed, ref } from 'vue';
import { getJSON, postJSON, putJSON } from './api';
import type { HostInfo, PluginInfo, RescanResult, TabEntry, UiPrefs } from './types';

/** tab 栏内容：来自已成功加载的插件前端入口（**自然顺序**：清单 order,id） */
export const tabs = ref<TabEntry[]>([]);

/**
 * 每个插件前端**声明**了哪些路径（`/w/<id>` 的子路径）。
 *
 * 只用于诊断：落到兜底页时能说清"它声明的是这些路径"，而不是含糊地说"没声明 routes"。
 */
export const pluginRoutes = ref<Record<string, string[]>>({});
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

// ---- 外壳偏好：标签栏顺序 + 默认首页 + 显示别名 --------------------------

/** 偏好读不到 / 被清空时的样子：顺序=清单顺序、首页=第一个可用 tab、没有别名 */
function emptyUiPrefs(): UiPrefs {
  return {
    tabOrder: [],
    home: null,
    tabAliases: {},
    homeLabel: '',
    keepAlive: [],
    globals: { comfyuiBaseUrl: '' },
  };
}

/** 后端 `<dataDir>/host.json` 偏好段的镜像；读不到时保持默认值 */
export const uiPrefs = ref<UiPrefs>(emptyUiPrefs());

/** 别名表只取"非空字符串"的条目 —— 宿主已经洗过一遍，这里只是不信任任何网络输入 */
function readAliases(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias === 'string' && alias !== '') out[id] = alias;
  }
  return out;
}

/**
 * 插件 id 列表只取"非空字符串"的条目：宿主已经洗过一遍，这里同样不信任网络输入
 * （拼进 `<KeepAlive :include>` 的东西不能有 `,` —— 那是 Vue 的分隔符语义）。
 */
function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id !== '' && !id.includes(','));
}

/**
 * 读外壳偏好。**读失败不算错误**：偏好只决定"顺序、落点和显示名"，
 * 拿不到就按默认走（清单顺序 + 第一个可用 tab + 插件自己的名字），不该把整个外壳一起拖下水。
 */
export async function fetchUiPrefs(): Promise<void> {
  try {
    const data = await getJSON<{ prefs: UiPrefs }>('/api/ui');
    const prefs = data.prefs;
    uiPrefs.value = {
      tabOrder: Array.isArray(prefs?.tabOrder) ? prefs.tabOrder : [],
      home: typeof prefs?.home === 'string' && prefs.home !== '' ? prefs.home : null,
      tabAliases: readAliases(prefs?.tabAliases),
      homeLabel: typeof prefs?.homeLabel === 'string' ? prefs.homeLabel : '',
      keepAlive: readIdList(prefs?.keepAlive),
      // 宿主全局设置：拿不到就是空（= 不统一），不该把外壳一起拖下水
      globals: {
        comfyuiBaseUrl:
          typeof prefs?.globals?.comfyuiBaseUrl === 'string' ? prefs.globals.comfyuiBaseUrl : '',
      },
    };
  } catch (err) {
    console.warn('[host] 读取外壳偏好失败，按默认处理：', err);
    uiPrefs.value = emptyUiPrefs();
  }
}

/**
 * 写偏好：**只发改动的键**。后端把 `undefined` 的键当"这次没提"，其余键保持原样
 * （`PUT /api/ui` 的合并语义），所以两次并发保存不会互相覆盖 —— 别改成"整份镜像发过去"。
 * 返回的是**清洗后**的完整偏好，用它回填，保证界面显示的就是真存下来的那份。
 *
 * 统一地址只是宿主给的只读默认值：宿主不把它写进任何插件，所以这里没有"谁跟着变了"要回报。
 */
export async function saveUiPrefs(patch: Partial<UiPrefs>): Promise<void> {
  const data = await putJSON<{ prefs: UiPrefs }>('/api/ui', patch);
  uiPrefs.value = data.prefs;
}

/**
 * 让宿主重扫 `tabs/` 目录（D20：宿主不监听文件系统，这是**唯一**能改变装载状态的动作），
 * 然后重读清单。返回宿主的分项结果，调用方据此把"到底发生了什么"说清楚。
 *
 * 失败会抛：这个动作是用户明确点的，沉默地不生效比报错更难查。
 */
export async function rescanTabs(): Promise<RescanResult> {
  const result = await postJSON<RescanResult>('/api/tabs/rescan', {});
  await fetchPlugins();
  return result;
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

/** 顶栏品牌链接（首页 `/home`）的内置显示名：偏好留空时用它 */
export const HOME_FALLBACK_LABEL = 'comfyui-web';

/** 顶栏品牌链接的显示名：偏好优先，留空回落到内置名 */
export const homeLabel = computed(() => uiPrefs.value.homeLabel || HOME_FALLBACK_LABEL);

/**
 * tab 在顶栏上的显示名：别名优先，没配就用插件自己声明的 title。
 *
 * 别名是**外壳的**东西（`data/host.json` 的偏好段），插件自己的 title 一个字都不动 ——
 * 所以改别名既不用重挂插件，也不用插件配合。
 */
export function tabLabel(tab: { id: string; title: string }): string {
  const alias = uiPrefs.value.tabAliases[tab.id];
  return alias === undefined || alias === '' ? tab.title : alias;
}

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
