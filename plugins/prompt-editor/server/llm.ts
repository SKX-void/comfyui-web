/**
 * LLM 生成编排：OpenAI function-calling 的 agent loop（D27）。
 *
 * 边界：工具**即时落盘**、中途失败不回滚；轮次上限 + 总超时兜底；
 * 一次 `/llm/generate` 提交只算 1 次用量（内部多轮 tool call 不另计 —— 计数在 routes-llm）。
 */
import type { LlmReasoning, LlmSettings } from './settings.js';
import { LlmError, openAiCompatibleChat, type LlmMessage, type LlmToolCall, type LlmToolSpec } from './llm-providers.js';
import { asRecord, errorMessage } from './util.js';

export interface LlmToolOutcome {
  /** 返回给模型的 JSON 字符串：模型要靠它知道这步成没成、下一步写什么 */
  content: string;
}

export interface LlmToolKit {
  setBlock(input: Record<string, unknown>): Promise<LlmToolOutcome>;
  suggest(input: Record<string, unknown>): Promise<LlmToolOutcome>;
  searchTags(input: Record<string, unknown>): Promise<LlmToolOutcome>;
}

export interface LlmAgentOptions {
  llm: LlmSettings;
  /** 本次请求的推理强度（D29）：来自请求体，缺省 off —— 不是 settings 里的字段 */
  reasoning: LlmReasoning;
  system: string;
  user: string;
  toolkit: LlmToolKit;
  /** 本次要发的工具表：按 `llm.tagSearch` 装配（`llmTools()`）—— 关掉查库时那个工具根本不在表里 */
  tools: LlmToolSpec[];
  /** 多轮对话的历史（纯文本 user/assistant 对），插在 system 与本次 user 之间 */
  history?: LlmMessage[];
  /** 预设里 role=user / assistant 的分段（D30）：按顺序排在 history 与本次指令之间 */
  extras?: LlmMessage[];
  /** 逐轮日志：链式调用（一轮 tool call = 多一次 provider 往返）在别处完全看不见 */
  log?: (message: string) => void;
  fetchImpl?: Parameters<typeof openAiCompatibleChat>[1];
}

export interface LlmAgentOutcome {
  summary: string;
  toolCalls: number;
  aborted: boolean;
  error?: { code: string; message: string };
}

const WRITE_TOOLS: LlmToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'set_block',
      description:
        '写入（新建或改写）一个提示词区块。id 留空 = 新建（title 必填）；id 给出时必须是本次请求允许改写的区块，否则会被拒绝 —— 被拒的块改用 suggest。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要改写的区块 id；新建时省略或传空串' },
          title: { type: 'string', description: '区块标题；新建时必填，改写时缺省保留原标题' },
          mode: { type: 'string', enum: ['tag', 'text'], description: '区块风格；缺省沿用原风格，新建时缺省 tag' },
          content: {
            type: 'string',
            description: '区块新内容：tag 块 = 英文逗号分隔的标签串；text 块 = 英文句子（句号结尾）',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest',
      description: '对不在可写范围内的区块给出修改建议（不落盘；前端展示后由用户人工应用）。',
      parameters: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: '目标区块 id' },
          content: { type: 'string', description: '建议的新内容' },
        },
        required: ['blockId', 'content'],
      },
    },
  },
];

/**
 * 词库查询工具（D32）：**模型自己决定要不要查**。
 * 说清"库外不是禁区"是必须的 —— 词库是 danbooru 对照表，它不认识的写法（新兴标签、text 块）
 * 照样能出图，写成白名单会让模型不敢下笔。
 */
const SEARCH_TAGS_TOOL: LlmToolSpec = {
  type: 'function',
  function: {
    name: 'search_tags',
    description:
      '在 danbooru 词库里搜标签，返回库内正名、中文与分类。写 tag 块前用它核对写法：同一个意思往往只有个别正名被画图模型认得，近义写法可能完全不生效；includeRelated 打开时另附常与命中词一起出现的标签（找搭配用）。词库只是参考不是白名单 —— 库外的新兴标签照写。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词：英文标签片段或中文都行（搜正名 / 译文 / 别名）' },
        includeRelated: { type: 'boolean', description: 'true = 附带命中词的共现邻居' },
      },
      required: ['query'],
    },
  },
};

/** 本次的工具表：关掉查库时 `search_tags` 根本不出现 —— 模型调不到，也就不会瞎试 */
export function llmTools(allowTagSearch: boolean): LlmToolSpec[] {
  return allowTagSearch ? [...WRITE_TOOLS, SEARCH_TAGS_TOOL] : [...WRITE_TOOLS];
}

/**
 * 查库开关的**送达方式**：工具表之外再往 system 里补一句（D32）。
 * 模板归用户、删得掉，这一句由 `llm-run.ts` 拼在模板之后，删不掉。
 * 文案只跟开关有关（静态），所以它待在 system 前缀里不砸缓存（D31）。
 */
export function tagSearchNotice(allowTagSearch: boolean): string {
  return allowTagSearch
    ? '词库查询可用：工具 search_tags 能查 danbooru 词库的正名 / 中文 / 分类与共现邻居。写 tag 块前建议核对一次写法；词库只是参考，库外的写法照写。'
    : '词库查询本次不可用（search_tags 不在工具表里）：直接用你的知识写标签，不要假装查过库。';
}

/**
 * agent loop：每轮一次 chat；模型只要返回 tool_calls 就逐个执行并回填 tool 消息，
 * 直到它给出不带 tool_calls 的收尾回复、轮次用尽或总超时。
 */
export async function runLlmAgent(options: LlmAgentOptions): Promise<LlmAgentOutcome> {
  const messages: LlmMessage[] = [
    // 预设里可能一段 system 都没启用：空 system 有的 provider 会 400，索性不发这条
    ...(options.system === '' ? [] : [{ role: 'system', content: options.system } as LlmMessage]),
    ...(options.history ?? []),
    ...(options.extras ?? []),
    { role: 'user', content: options.user },
  ];
  // 总超时兜底：每次调用本身有 timeoutMs，这里再包一层"轮数 × 单次超时"的墙
  const deadline = Date.now() + options.llm.timeoutMs * (options.llm.maxToolRounds + 1);
  const log = options.log ?? ((): void => {});
  let summary = '';
  let toolCalls = 0;

  log(
    `LLM 提交：system ${options.system.length} 字、历史 ${(options.history ?? []).length} 条、模板段 ${(options.extras ?? []).length} 条、上限 ${options.llm.maxToolRounds} 轮`,
  );

  for (let round = 0; round <= options.llm.maxToolRounds; round += 1) {
    if (Date.now() > deadline) {
      log(`LLM 第 ${round + 1} 轮：总超时，提前收工`);
      return { summary, toolCalls, aborted: true };
    }

    let result;
    try {
      result = await openAiCompatibleChat(
        {
          baseUrl: options.llm.baseUrl,
          apiKey: options.llm.apiKey,
          model: options.llm.model,
          timeoutMs: options.llm.timeoutMs,
          messages,
          reasoning: options.reasoning,
          headers: options.llm.headers,
          tools: options.tools,
        },
        options.fetchImpl,
      );
    } catch (error) {
      if (error instanceof LlmError) return { summary, toolCalls, aborted: false, error: { code: error.code, message: error.message } };
      return { summary, toolCalls, aborted: false, error: { code: 'PROVIDER', message: errorMessage(error) } };
    }

    const calls = result.toolCalls;
    if (calls.length === 0) {
      summary = result.content;
      log(`LLM 第 ${round + 1} 轮：收尾回复（${summary.length} 字）`);
      return { summary, toolCalls, aborted: false };
    }

    toolCalls += calls.length;
    log(`LLM 第 ${round + 1} 轮：${calls.map(describeCall).join('、')}`);
    messages.push({ role: 'assistant', content: result.content, tool_calls: calls });
    for (const call of calls) {
      const outcome = await dispatch(options.toolkit, call.function.name, parseArguments(call.function.arguments));
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
    }
  }

  log(`LLM 轮数用尽（${options.llm.maxToolRounds} 轮），提前收工`);
  return { summary, toolCalls, aborted: true };
}

/** 工具调用的单行摘要：arguments 里带 content（可能很长），截一段够认出是哪次调用 */
const ARG_LOG_LIMIT = 120;

function describeCall(call: LlmToolCall): string {
  const args = call.function.arguments.replace(/\s+/g, ' ');
  return `${call.function.name}(${args.length > ARG_LOG_LIMIT ? `${args.slice(0, ARG_LOG_LIMIT)}…` : args})`;
}

function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value = asRecord(JSON.parse(raw));
    if (value === null) return { ok: false, message: `工具参数必须是 JSON 对象：${raw}` };
    return { ok: true, value };
  } catch {
    return { ok: false, message: `工具参数不是合法 JSON：${raw}` };
  }
}

async function dispatch(
  toolkit: LlmToolKit,
  name: string,
  args: { ok: true; value: Record<string, unknown> } | { ok: false; message: string },
): Promise<LlmToolOutcome> {
  if (!args.ok) return { content: JSON.stringify({ ok: false, error: args.message }) };
  if (name === 'set_block') return toolkit.setBlock(args.value);
  if (name === 'suggest') return toolkit.suggest(args.value);
  if (name === 'search_tags') return toolkit.searchTags(args.value);
  return { content: JSON.stringify({ ok: false, error: `未知工具 ${name}` }) };
}
