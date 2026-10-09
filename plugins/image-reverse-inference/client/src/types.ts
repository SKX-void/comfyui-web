/** 前端用到的载荷类型（服务端 `server/model.ts` 的镜像） */

/**
 * 一次反推真正用到的参数：设置的默认值 + 表单里的覆盖。
 *
 * 没有 `model` —— 模型是工作流的事实（`workflow.json` 的 tagger 节点），
 * 不是可以在这里改的参数。
 */
export interface TaggerParams {
  threshold: number;
  characterThreshold: number;
  replaceUnderscore: boolean;
  trailingComma: boolean;
  excludeTags: string;
}
