import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError } from '../errors.js';
import type {
  ComfyClient,
  ComfyEvent,
  HistoryEntry,
  QueueInfo,
  SubmitResult,
  ViewParams,
} from './types.js';
import type { Graph } from '@comfyui-server/shared';

// ---------------------------------------------------------------------------
// 极简 PNG 编码器（无第三方依赖）——让 mock 产出真实可显示的图片
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成一张竖向渐变 PNG，便于肉眼确认"确实出图了" */
export function makePlaceholderPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    const t = y / Math.max(1, height - 1);
    const r = Math.round(40 + 120 * t);
    const g = Math.round(80 + 100 * (1 - t));
    const b = Math.round(180 - 60 * t);
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      // 叠一层细网格，方便识别缩放
      const grid = x % 64 === 0 || y % 64 === 0 ? 30 : 0;
      raw[p] = Math.min(255, r + grid);
      raw[p + 1] = Math.min(255, g + grid);
      raw[p + 2] = Math.min(255, b + grid);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Mock 客户端
// ---------------------------------------------------------------------------

interface MockJob {
  promptId: string;
  graph: Graph;
  images: Array<{ filename: string; subfolder: string; type: string }>;
  outputNodeId: string;
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
}

/** 视为"产出图像"的终端节点类型 */
const SAVE_NODE_TYPES = new Set(['SaveImage', 'SaveImagePlus', 'PreviewImage']);

interface MockOptions {
  stepDelayMs: number;
  log?: (msg: string, meta?: unknown) => void;
}

/**
 * 内置模拟器：无需 ComfyUI 即可跑通「提交 → 进度 → 出图」全链路。
 *
 * 事件序列刻意对齐真实 ComfyUI（v1-api.md §B.2）：
 *   status → execution_start → executing → progress×N → executed
 */
export class MockComfyClient implements ComfyClient {
  readonly mode = 'mock' as const;

  private readonly jobs = new Map<string, MockJob>();
  private readonly emitter = new EventEmitter();
  private readonly stepDelayMs: number;
  private readonly log: (msg: string, meta?: unknown) => void;
  private started = false;

  constructor(opts: MockOptions) {
    this.stepDelayMs = opts.stepDelayMs;
    this.log = opts.log ?? (() => {});
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    this.started = true;
    this.log('Mock ComfyUI 已就绪（无需真实 ComfyUI）');
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
    }
    this.jobs.clear();
  }

  isConnected(): boolean {
    return this.started;
  }

  subscribe(handler: (evt: ComfyEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  private emit(type: ComfyEvent['type'], data: Record<string, unknown>): void {
    this.emitter.emit('event', { type, data });
  }

  async submit(graph: Graph, _clientId: string, _extraData?: Record<string, unknown>): Promise<SubmitResult> {
    const promptId = randomUUID();
    const saveNodes = Object.entries(graph).filter(
      ([, node]) => SAVE_NODE_TYPES.has(node.class_type),
    );
    const outputNodeId = saveNodes[0]?.[0] ?? Object.keys(graph)[0] ?? '1';

    let width = 832;
    let height = 1216;
    for (const [, node] of Object.entries(graph)) {
      if (node.class_type === 'EmptyLatentImage') {
        if (typeof node.inputs.width === 'number') width = node.inputs.width;
        if (typeof node.inputs.height === 'number') height = node.inputs.height;
      }
    }

    const prefix =
      typeof saveNodes[0]?.[1].inputs.filename_prefix === 'string'
        ? (saveNodes[0][1].inputs.filename_prefix as string)
        : 'mock';


    const job: MockJob = {
      promptId,
      graph,
      images: [
        {
          filename: `${prefix}_${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}_.png`,
          subfolder: '',
          type: 'output',
        },
      ],
      outputNodeId,
      timedOut: false,
      timer: null,
    };
    this.jobs.set(promptId, job);
    (job as MockJob & { width: number; height: number }).width = width;
    (job as MockJob & { width: number; height: number }).height = height;

    // 异步播放事件序列
    setTimeout(() => this.runJob(job), this.stepDelayMs);

    return { promptId, number: this.jobs.size, nodeErrors: {} };
  }

  private runJob(job: MockJob): void {
    if (!this.jobs.has(job.promptId)) return;
    const meta = job as MockJob & { width: number; height: number };

    this.emit('status', {
      status: { exec_info: { queue_remaining: this.jobs.size - 1 } },
      sid: 'mock',
    });

    setTimeout(() => {
      if (!this.jobs.has(job.promptId)) return;
      this.emit('execution_start', { prompt_id: job.promptId });

      // 依次"执行"若干节点
      const nodeIds = Object.keys(job.graph);
      const total = 20;
      let step = 0;

      const tick = (): void => {
        if (!this.jobs.has(job.promptId)) return;
        if (step <= total) {
          const nodeId =
            nodeIds[Math.min(nodeIds.length - 1, Math.floor((step / total) * nodeIds.length))]!;
          this.emit('executing', { node: nodeId, prompt_id: job.promptId });
          this.emit('progress', {
            value: step,
            max: total,
            node: nodeId,
            prompt_id: job.promptId,
          });
          step += 1;
          setTimeout(tick, this.stepDelayMs);
          return;
        }

        // 完成：真实 ComfyUI 在结束信号之前就已把结果写入 history
        job.timedOut = true;
        this.emit('executing', { node: null, prompt_id: job.promptId });
        this.emit('executed', {
          node: job.outputNodeId,
          output: { images: job.images },
          prompt_id: job.promptId,
        });
      };
      setTimeout(tick, this.stepDelayMs);
    }, this.stepDelayMs);
  }

  async getHistory(promptId: string): Promise<HistoryEntry | null> {
    const job = this.jobs.get(promptId);
    if (!job) return null;
    if (!job.timedOut) {
      return {
        promptId,
        outputs: {},
        statusStr: 'in_progress',
        completed: false,
      };
    }
    return {
      promptId,
      outputs: { [job.outputNodeId]: { images: job.images } },
      statusStr: 'success',
      completed: true,
    };
  }

  async getQueue(): Promise<QueueInfo> {
    const pending = [...this.jobs.values()]
      .filter((j) => !j.timedOut)
      .map((j) => ({ promptId: j.promptId }));
    return { running: pending.slice(0, 1), pending: pending.slice(1) };
  }

  async getObjectInfo(): Promise<Record<string, unknown>> {
    // 模拟一个"节点齐全"的 ComfyUI：模板 requirements.nodes 的校验依赖它
    const nodeTypes = [
      'UNETLoader',
      'CLIPLoader',
      'VAELoader',
      'EmptyLatentImage',
      'ClownsharKSampler_Beta',
      'KSampler',
      'VAEDecode',
      'SaveImage',
      'SaveImagePlus',
      'PreviewImage',
      'CLIPTextEncode',
      'CLIPTextEncodeSDXL',
      'LatentRotate',
      'CR Text',
      'PrimitiveFloat',
      'INTConstant',
      'Seed (rgthree)',
      'WeiLinPromptUI',
      'WeiLinPromptUIWithoutLora',
      'WeiLinPromptUIOnlyLoraStack',
      'AnimaLayerReplayPatcher',
      'AnimaTeaCache',
    ];
    return Object.fromEntries(
      nodeTypes.map((t) => [t, { input: { required: {} }, output: [], name: t }]),
    );
  }

  async getSystemStats(): Promise<unknown> {
    return {
      system: { comfyui_version: 'mock', python_version: 'mock' },
      devices: [{ name: 'mock-device', vram_total: 0, vram_free: 0 }],
    };
  }

  async getModels(folder: string): Promise<string[]> {
    const table: Record<string, string[]> = {
      diffusion_models: [
        'Anima\\0.26.9.12.NAI.RDBT  Anima.b1V23Base_fp16.safetensors',
        'mock\\model_b.safetensors',
      ],
      loras: [
        'Anima\\Anima Turbo LoRA-v0.2.safetensors',
        'Anima\\画师\\taffy-style.safetensors',
      ],
      vae: ['mock_vae.safetensors'],
      text_encoders: ['mock_clip.safetensors'],
    };
    return table[folder] ?? [];
  }

  async interrupt(): Promise<void> {
    this.log('Mock interrupt 被调用');
  }

  async fetchImage(params: ViewParams): Promise<{ data: Buffer; contentType: string }> {
    const job = [...this.jobs.values()].find((j) =>
      j.images.some((img) => img.filename === params.filename),
    );
    if (!job) {
      throw AppError.comfyError(`mock 中找不到图片: ${params.filename}`);
    }
    const meta = job as MockJob & { width: number; height: number };
    const w = Math.min(meta.width ?? 832, 832);
    const h = Math.round((w * (meta.height ?? 1216)) / (meta.width ?? 832));
    // mock 自带零依赖的 PNG 编码器：不为了"格式保真"去依赖原生库
    return { data: makePlaceholderPng(w, h), contentType: 'image/png' };
  }
}
