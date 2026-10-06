import fs from 'node:fs';

/**
 * 「上次提交的出图参数」快照（`<space>/last-state.json`）。
 *
 * 为什么**单开一个文件**，而不是塞进 `settings.json`：
 * settings.json 是本插件的**配置**（只有 `SETTING_KEYS` 那几个键，改完要重挂才生效、
 * 在设置界面里编辑），而这里是**运行期状态** —— 每次点「开始生成」随手覆盖、刷新页面回填。
 * 两者的生命周期和"读坏了怎么办"完全不同：配置读坏要能被设置页看见，
 * 状态读坏只需静悄悄退回模板默认值。混在一个文件里，写状态就会把配置一起重写一遍。
 *
 * 写入与 `triggers/store.ts` 同款：先写 `.tmp` 再 rename，写一半崩了不留半截 JSON。
 * 文件就是普通 JSON —— 排障时直接看，**删掉 = 回到模板默认值**，没有别的副作用。
 */

const FILE_NAME = 'last-state.json';
const FORMAT_VERSION = 1;

/** 只要空间句柄的这两件事，省得为了一个路径去 import 宿主类型 */
export interface StateSpace {
  readonly root: string;
  resolve(rel: string): string;
}

export interface LastState {
  /** 上次提交的表单值（键 = 模板 input 的 key） */
  values: Record<string, unknown>;
  /** 上次保存时刻（ISO 8601）；没存过为 null */
  savedAt: string | null;
  /** 快照文件的位置（排障用） */
  file: string;
  /** 文件在、但读不出来时的原因；没存过时为空 */
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stateFile(space: StateSpace): string {
  return space.resolve(FILE_NAME);
}

export class LastStateStore {
  private readonly file: string;

  constructor(
    space: StateSpace,
    private readonly log?: (msg: string, meta?: unknown) => void,
  ) {
    this.file = stateFile(space);
  }

  /**
   * 读快照。**不做**校验/收敛：值对不对是前端按模板 input 判的（`restoreValues`），
   * 这里只负责"文件里的东西原样给出"。没存过（ENOENT）是正常状态，读坏了才报 error。
   */
  read(): LastState {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isPlainObject(raw)) {
        return { values: {}, savedAt: null, file: this.file, error: '快照不是一个 JSON 对象' };
      }
      return {
        values: isPlainObject(raw.values) ? raw.values : {},
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
        file: this.file,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return { values: {}, savedAt: null, file: this.file };
      }
      return {
        values: {},
        savedAt: null,
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 覆盖式写快照（每次都是全量，不做增量：参数只有一份"上次的"）。
   *
   * `keys` 传当前模板的 input key —— 落盘时把不相干的键滤掉，
   * 否则换过模板的机器上，文件里会一直躺着一批早就没有的字段。
   */
  write(values: Record<string, unknown>, keys: readonly string[]): LastState {
    const clean: Record<string, unknown> = {};
    for (const key of keys) {
      if (values[key] !== undefined) clean[key] = values[key];
    }

    const savedAt = new Date().toISOString();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ version: FORMAT_VERSION, savedAt, values: clean }, null, 2)}\n`,
      'utf8',
    );
    fs.renameSync(tmp, this.file);
    this.log?.('上次参数已保存', { file: this.file, keys: Object.keys(clean).length });
    return { values: clean, savedAt, file: this.file };
  }
}
