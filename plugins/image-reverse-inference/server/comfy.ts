/**
 * ComfyUI 客户端：上传图片 + 提交 + 取结果。
 *
 * 只 import node 内置模块（`fetch` / `FormData` / `Blob` / `AbortSignal.timeout` 都是运行期全局），
 * 不引任何第三方依赖 —— 这是"服务端能打成单文件"的前提。
 *
 * 这里刻意**不建 WebSocket**：反推是一次几秒的短任务，轮询 `/history` 的代码量只有
 * 共享 /ws 的零头（进度条那套复杂度留给 anima-plus）。
 */
import { randomUUID } from 'node:crypto';

import { INFER_TIMEOUT_MS, UPLOAD_SUBFOLDER } from './meta.js';
import type { Graph, HistoryEntry, UploadedImage, WorkflowBindings } from './model.js';

interface PromptResponse {
  prompt_id?: unknown;
  node_errors?: unknown;
  error?: unknown;
}

interface StatsResponse {
  system?: { comfyui_version?: unknown; os?: unknown };
  devices?: Array<{ name?: unknown; type?: unknown }>;
}

export class ComfyClient {
  baseUrl: string;
  clientId: string;
  log: (msg: string) => void;

  constructor(baseUrl: string, log: (msg: string) => void) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.clientId = randomUUID();
    this.log = log;
  }

  setBaseUrl(baseUrl: string): void {
    const next = baseUrl.replace(/\/+$/, '');
    if (next === this.baseUrl) return;
    this.baseUrl = next;
    this.log(`ComfyUI 地址改为 ${next}`);
  }

  async #json<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} 返回 ${res.status}：${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /**
   * `POST /upload/image`（multipart）。
   *
   * 服务端自己组 multipart 的原因见 server/index.ts 头注释：浏览器的 FormData 到不了这里
   * —— 宿主的 fastify 只认 application/json 与 text/plain，别的 content-type 直接 415。
   */
  async uploadImage(bytes: Buffer, filename: string): Promise<UploadedImage> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)]), filename);
    form.append('type', 'input');
    form.append('subfolder', UPLOAD_SUBFOLDER);
    form.append('overwrite', 'true');

    const res = await fetch(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`上传图片失败（${res.status}）：${text.slice(0, 300)}`);

    const data = JSON.parse(text) as Record<string, unknown>;
    const name = data.name;
    if (typeof name !== 'string' || name === '') throw new Error('上传成功但没拿到文件名');
    return {
      name,
      subfolder: typeof data.subfolder === 'string' ? data.subfolder : '',
      type: typeof data.type === 'string' ? data.type : 'input',
    };
  }

  /** `POST /prompt`；节点校验失败在提交时就报出来，不用等到超时 */
  async submit(graph: Graph): Promise<string> {
    const data = await this.#json<PromptResponse>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    const nodeErrors = data.node_errors;
    if (nodeErrors !== undefined && nodeErrors !== null && Object.keys(nodeErrors).length > 0) {
      throw new Error(`工作流校验失败：${JSON.stringify(nodeErrors).slice(0, 500)}`);
    }
    const promptId = data.prompt_id;
    if (typeof promptId !== 'string' || promptId === '') {
      throw new Error(`提交失败：${JSON.stringify(data).slice(0, 300)}`);
    }
    return promptId;
  }

  /** `/history/<id>`：还没跑完时 ComfyUI 返回 `{}` */
  async history(promptId: string): Promise<HistoryEntry | null> {
    const raw = await this.#json<Record<string, unknown> | null>(
      `/history/${encodeURIComponent(promptId)}`,
    );
    const entry = raw ? raw[promptId] : undefined;
    if (entry === null || typeof entry !== 'object') return null;
    const rec = entry as { outputs?: unknown; status?: unknown };
    const status = (rec.status ?? {}) as { completed?: unknown; status_str?: unknown; messages?: unknown };
    const completed = Boolean(status.completed);
    const statusStr = typeof status.status_str === 'string' ? status.status_str : '';
    const outputs =
      rec.outputs !== null && typeof rec.outputs === 'object'
        ? (rec.outputs as Record<string, unknown>)
        : {};
    const error = completed && statusStr === 'error' ? extractError(status.messages) : undefined;
    return { outputs, completed, statusStr, ...(error !== undefined ? { error } : {}) };
  }

  /** 轮询到跑完（或超时）。返回终态的 history 条目 */
  async waitFor(promptId: string, timeoutMs = INFER_TIMEOUT_MS): Promise<HistoryEntry> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entry = await this.history(promptId);
      if (entry !== null && (entry.completed || entry.statusStr === 'error')) {
        if (entry.error !== undefined) throw new Error(entry.error);
        return entry;
      }
      if (Date.now() >= deadline) {
        // 超时就把这个 prompt 从队列里摘掉，别让它继续占着显卡
        await this.interrupt().catch(() => undefined);
        throw new Error(`等结果超时（${Math.round(timeoutMs / 1000)}s）`);
      }
      await sleep(700);
    }
  }

  async interrupt(): Promise<void> {
    await this.#json('/interrupt', { method: 'POST' });
  }

  /** `/system_stats`：只为了给设置页显示"连没连上" */
  async stats(): Promise<{ version: string | null; device: string | null }> {
    const data = await this.#json<StatsResponse>('/system_stats', {}, 5_000);
    const version = data.system?.comfyui_version;
    const device = Array.isArray(data.devices) ? data.devices[0]?.name : undefined;
    return {
      version: typeof version === 'string' ? version : null,
      device: typeof device === 'string' ? device : null,
    };
  }

  /** `/object_info/<class_type>`：拿某个节点的可选值（这里只用 WD14Tagger 的 model 列表） */
  async objectInfo(classType: string): Promise<Record<string, unknown> | null> {
    const data = await this.#json<Record<string, unknown>>(
      `/object_info/${encodeURIComponent(classType)}`,
      {},
      15_000,
    );
    const node = data[classType];
    return node !== null && typeof node === 'object' ? (node as Record<string, unknown>) : null;
  }
}

/**
 * 从 history 的 outputs 里取反推文本。
 *
 * 实测两种落点：
 *   `WD14Tagger|pysssss` → `outputs["53"].tags = ["a, b, c"]`（output_is_list=true，数组里一整串）
 *   `PreviewAny`         → `outputs["54"].text = ["a, b, c"]`
 * 先问 tagger 自己的输出，拿不到再退到 PreviewAny。
 */
export function extractTags(entry: HistoryEntry, bindings: WorkflowBindings): string | null {
  const candidates = [bindings.taggerId, bindings.previewId].filter(
    (id): id is string => typeof id === 'string',
  );
  for (const nodeId of candidates) {
    const text = firstText(entry.outputs[nodeId]);
    if (text !== null) return text;
  }
  return null;
}

function firstText(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const rec = output as Record<string, unknown>;
  for (const key of ['tags', 'text']) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (Array.isArray(value)) {
      const found = value.find((item) => typeof item === 'string' && item.trim() !== '');
      if (typeof found === 'string') return found;
    }
  }
  return null;
}

/** ComfyUI 把节点异常塞在 `status.messages` 的 execution_error 里 */
function extractError(messages: unknown): string {
  if (!Array.isArray(messages)) return 'ComfyUI 执行失败（没有更多信息）';
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    const payload = message[1];
    if (payload === null || typeof payload !== 'object') continue;
    const rec = payload as Record<string, unknown>;
    for (const key of ['exception_message', 'exception_type', 'message']) {
      const value = rec[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return 'ComfyUI 执行失败（没有更多信息）';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
