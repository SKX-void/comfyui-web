/**
 * 跨域调用：把本插件的输出当作**另一个插件**的输入，由它去出图。
 *
 * 边界（docs/architecture.md §8/§9.2）：插件之间**只有 HTTP 一条路** ——
 * 不 import 对方的代码、不读对方的库文件。所以每个下游自己实现下面这套接口，
 * 在自己那一侧拼请求；UI 只认接口，不认识 anima-plus。
 *
 * 依赖方向单向：prompt-editor → 下游。下游不知道我们存在。
 */

/** 现在能不能调：`ok:false` 时 detail 是给人看的原因（按钮就禁用在这一句上） */
export interface CrossCallAvailability {
  ok: boolean;
  detail: string;
}

/** 参数摘要的一行（模型 / 尺寸 / 步数……）：纯展示，不参与提交 */
export interface CrossCallParam {
  label: string;
  value: string;
}

/** 一次跨域调用**将要发出去的东西** */
export interface CrossCallPlan {
  /** 真正提交给对方的那一份表单值（输出已经填进它的描述提示词） */
  values: Record<string, unknown>;
  params: CrossCallParam[];
  /** 这次用的种子；对方没有种子字段时为 null */
  seed: number | null;
  /** 种子是不是这次重抽的（对方开着随机种子开关） */
  redrewSeed: boolean;
}

export type CrossCallPlanResult = { ok: true; plan: CrossCallPlan } | { ok: false; detail: string };

/** 调用回执：作业已经在对方的队列里了 */
export interface CrossCallReceipt {
  jobId: string;
  promptId: string;
  status: string;
  queuePosition: number | null;
  /** 这次实际提交出去的种子（对方没这个字段时为 null） */
  seed: number | null;
  /** 非致命提醒（例如写回对方快照失败）；空串 = 一路顺利 */
  warning: string;
}

export interface CrossCallTarget {
  /** 就是对方的插件 id：也用它拼 `/api/p/<id>` 与 `/w/<id>` */
  id: string;
  /** 下拉框里的名字 */
  label: string;
  /** 对方装没装、能不能用 —— 只读宿主清单，不发对方的插件请求 */
  probe(): Promise<CrossCallAvailability>;
  /** 读对方的参数基底 + 把输出填进它的描述提示词（不发写请求） */
  plan(text: string): Promise<CrossCallPlanResult>;
  /** 写回对方状态 + 发起调用 */
  submit(plan: CrossCallPlan): Promise<CrossCallReceipt>;
}
