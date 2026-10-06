/** WeiLin 适配层的公开类型与上游响应形状（plugins/anima-plus/docs/weilin.md §3）。 */

export interface WeilinLoraEntry {
  /** 含扩展名的完整名，如 "Anima\\画师\\taffy-style.safetensors" */
  path: string;
  /** 不含扩展名，可直接写入模板的 lora 字段 */
  name: string;
  /** 所在目录（可能是多级，如 "Anima\\画师"） */
  folder: string;
  /** 末级文件名（用于展示） */
  displayName: string;
}

/** get_lora_folder_list 的返回：{ all: [...], <folder>: { all: [...], ... } } */
export type FolderNode = { all?: string[]; [k: string]: FolderNode | string[] | undefined };

export interface WeilinTag {
  id: number;
  text: string;
  /** 中文释义 */
  translate: string;
  color: string;
  /** 所属顶层组名，如 "人物" */
  topGroup: string;
  /** 所属子组名，如 "头发" */
  group: string;
}

export interface WeilinTopGroup {
  id: number;
  name: string;
  color: string;
  subgroups: Array<{ id: number; name: string; color: string; tagCount: number }>;
  tagCount: number;
}

export interface WeilinLoraInfo {
  file: string;
  /** 触发词（来自 Civitai trainedWords 或元数据） */
  triggerWords: string[];
  /** 用户编辑的触发词（节点不读取，仅展示） */
  loraWorks: string;
  civitaiName: string;
  nsfwLevel: number | null;
  baseModel: string;
}

export interface WeilinStatus {
  available: boolean;
  /** LoRA 索引是否加载完成 */
  isLoading: boolean;
  progress: number;
  total: number;
  current: number;
  message?: string;
}

