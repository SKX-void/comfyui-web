import type {
  CrossCallAvailability,
  CrossCallParam,
  CrossCallPlan,
  CrossCallPlanResult,
  CrossCallReceipt,
  CrossCallTarget,
} from './types';

/**
 * anima-plus 适配器 —— 本插件唯一的下游。
 *
 * 下面几条是与 anima-plus **逐字对齐**的复刻（不是巧合），对方改了要跟着改：
 *   - `drawSeed()` 的区间 ← anima-plus/client/src/form.ts（上界 2^53-1，与它的
 *     server/workflow/transforms.ts 的 randomSeed() 同一区间）
 *   - 「randomSeed 开着就先抽定种子再提交」 ← anima-plus/client/src/composables/useJobs.ts 的 submit()
 *   - 「先写 last-state 再建作业」 ← 同上。对方那次写是 `void` 不等的；我们等它，
 *     为的是写失败时能说一句（作业已经发出去了，所以只是提醒）
 *   - 摘要里那几个 key ← anima-plus/assets/form.json 的 inputs
 *
 * 跨插件只能走 HTTP（docs/architecture.md §8/§9.2）：不 import 对方代码、不读对方库文件。
 */
export const TARGET_ID = 'anima-plus';
export const TARGET_LABEL = 'anima-plus（出图）';

/** 对方的接口前缀（宿主统一加的 `/api/p/<id>`） */
const API_BASE = '/api/p/anima-plus';

/** 宿主清单里的那一行：只声明这里读的字段（真源在 apps/server/src/core-rows.ts） */
interface PluginRow {
  id: string;
  title?: string;
  enabled?: boolean;
  phase?: string;
  error?: string;
}

interface StatePayload {
  values?: Record<string, unknown>;
  savedAt?: string | null;
  file?: string;
  error?: string;
}

interface JobCreated {
  jobId: string;
  promptId?: string | null;
  status?: string;
  queuePosition?: number | null;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 跟本插件 api.ts 同款：`text()` + JSON.parse（不假设响应对象有 json()） */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (raw === '' ? null : JSON.parse(raw)) as T;
}

async function sendJson<T>(url: string, method: 'PUT' | 'POST', body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const data: unknown = raw === '' ? null : JSON.parse(raw);
  if (!response.ok) {
    const message = (data as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message ?? `HTTP ${response.status}`);
  }
  return data as T;
}

/**
 * 预热：让对方把**提交前那一步**要用的昂贵检查提前做掉。
 *
 * 对方的 `POST /api/jobs` 在返回前要确认工作流需要的节点类都装了，判据是 ComfyUI 的
 * `/object_info`（约 9MB / 2s，对方缓存 5 分钟 —— plugins/anima-plus/server/deps.ts），
 * 提交前的检查走同一份缓存。跨域这条路对方页面常常**从没打开过**（没人做过这次检查），
 * 于是"第一次发图"要干等 2s。读一次它的依赖报告，把那份缓存热起来。
 *
 * 节流取 2 分钟（小于对方的 5 分钟 TTL）：写提示词往往要几分钟，只在挂载时热一次不够，
 * 边写边热才能保证按下按钮时缓存还是热的。失败一律静默 —— 预热只省时间，
 * 真提交时对方会给出准确的错误（上游不可达时它的检查本来就跳过）。
 */
const WARM_MIN_INTERVAL_MS = 2 * 60_000;
let warmedAt = 0;

export function warm(): void {
  const now = Date.now();
  if (now - warmedAt < WARM_MIN_INTERVAL_MS) return;
  warmedAt = now;
  try {
    void fetch(`${API_BASE}/api/deps`).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // 没有 fetch 的环境（SSR 桩 / 老浏览器）：不预热，也不该影响任何事
  }
}

/** 对方在不在、能不能用。宿主清单是唯一的真源：没装载的 tab 根本不出现在里面 */
export async function probe(): Promise<CrossCallAvailability> {
  let rows: PluginRow[];
  try {
    rows = (await getJson<{ plugins?: PluginRow[] }>('/api/plugins')).plugins ?? [];
  } catch (err) {
    return { ok: false, detail: `读不到宿主插件清单（${reason(err)}）` };
  }
  const row = rows.find((one) => one.id === TARGET_ID);
  if (row === undefined) {
    return { ok: false, detail: `宿主里没有 ${TARGET_ID}：没放进 tabs/，或者放进去后还没点「重新扫描插件目录」` };
  }
  if (row.enabled === false || row.phase === 'disabled') {
    return { ok: false, detail: `${TARGET_ID} 现在被停用（在设置页启用后回来点「刷新」）` };
  }
  if (row.phase !== 'active') {
    const why = row.error === undefined ? '' : `：${row.error}`;
    return { ok: false, detail: `${TARGET_ID} 现在不可用（${row.phase ?? '未知状态'}）${why}` };
  }
  // 能用就顺手预热：探测成功 = 马上要发图了，这时把对方 2s 的检查提前跑掉
  warm();
  return { ok: true, detail: `${row.title ?? TARGET_ID} 已就绪` };
}

/**
 * 抽一个种子，区间与 anima-plus 的 form.ts 一致（0 ~ 2^53-1）。
 * 上界取 2^53-1 而不是采样器声明的 2^64：超过 2^53 的整数在 JS number 里不保证精确。
 */
export function drawSeed(): number {
  const hi = Math.floor(Math.random() * 2 ** 21);
  const lo = Math.floor(Math.random() * 2 ** 32);
  return hi * 2 ** 32 + lo;
}

/** 取路径最后一段（对方的模型名是 `Anima\xxx.safetensors` 这种 Windows 路径） */
function basename(value: unknown): string {
  if (typeof value !== 'string') return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

/** 摘要行：只挑几个"一眼能认出这次要跑什么"的字段（键名来自对方 assets/form.json） */
export function paramsOf(values: Record<string, unknown>, redrewSeed: boolean): CrossCallParam[] {
  const out: CrossCallParam[] = [];
  const model = basename(values.unet_name);
  if (model !== '') out.push({ label: '模型', value: model });
  if (typeof values.width === 'number' && typeof values.height === 'number') {
    out.push({ label: '尺寸', value: `${values.width}×${values.height}` });
  }
  if (typeof values.steps === 'number') out.push({ label: '步数', value: String(values.steps) });
  if (typeof values.cfg === 'number') out.push({ label: 'CFG', value: String(values.cfg) });
  if (Array.isArray(values.loras)) {
    // 空名字的 LoRA 行对方提交时会剔掉（normalizeValues），摘要也得跟着剔，否则两边对不上
    const used = values.loras.filter(
      (one) => typeof (one as { name?: unknown })?.name === 'string' && ((one as { name: string }).name).trim() !== '',
    );
    out.push({ label: 'LoRA', value: `${used.length} 条` });
  }
  if (redrewSeed) out.push({ label: '种子', value: '每次重抽' });
  else if (typeof values.seed === 'number') out.push({ label: '种子', value: String(values.seed) });
  return out;
}

/**
 * 组包：以对方「最后一次状态」为基底，只换描述提示词（`prompt`）；随机种子开着就重抽一个。
 *
 * 纯函数（`draw` 可注入），为的是能在契约测试里断言 —— 真发出去的就是这份 `values`。
 */
export function buildPlan(saved: Record<string, unknown>, text: string, draw: () => number = drawSeed): CrossCallPlan {
  const values: Record<string, unknown> = { ...saved, prompt: text };
  const redrewSeed = values.randomSeed === true;
  let seed: number | null = typeof values.seed === 'number' ? values.seed : null;
  if (redrewSeed) {
    seed = draw();
    values.seed = seed;
  }
  return { values, seed, redrewSeed, params: paramsOf(values, redrewSeed) };
}

/** 读对方的快照当基底。没跑过一次就没有基底 —— 这一条是刻意的，不去猜模板默认值 */
export async function plan(text: string): Promise<CrossCallPlanResult> {
  let state: StatePayload;
  try {
    state = await getJson<StatePayload>(`${API_BASE}/api/state`);
  } catch (err) {
    return { ok: false, detail: `读不到 ${TARGET_ID} 的参数快照（${reason(err)}）` };
  }
  if (state.error !== undefined) {
    return { ok: false, detail: `${TARGET_ID} 的参数快照读不出来：${state.error}` };
  }
  const values = state.values ?? {};
  if (state.savedAt === null || state.savedAt === undefined || Object.keys(values).length === 0) {
    return {
      ok: false,
      detail: `${TARGET_ID} 还没有「最后一次状态」：先去那边按一次「开始出图」，跨域调用才有参数基底`,
    };
  }
  return { ok: true, plan: buildPlan(values, text) };
}

export async function submit(call: CrossCallPlan): Promise<CrossCallReceipt> {
  let warning = '';
  try {
    await sendJson(`${API_BASE}/api/state`, 'PUT', { values: call.values });
  } catch (err) {
    warning = `写回 ${TARGET_ID} 的参数快照失败（${reason(err)}），出图不受影响`;
  }
  const res = await sendJson<JobCreated>(`${API_BASE}/api/jobs`, 'POST', { values: call.values });
  return {
    jobId: res.jobId,
    promptId: res.promptId ?? '',
    status: res.status ?? '',
    queuePosition: typeof res.queuePosition === 'number' ? res.queuePosition : null,
    seed: call.seed,
    warning,
  };
}

export const animaPlus: CrossCallTarget = {
  id: TARGET_ID,
  label: TARGET_LABEL,
  probe,
  warm,
  plan,
  submit,
};
