/**
 * LLM 生成编排：OpenAI function-calling 的 agent loop（D27）。
 *
 * 边界：工具**即时落盘**、中途失败不回滚；轮次上限 + 总超时兜底；
 * 一次 `/llm/generate` 提交只算 1 次用量（内部多轮 tool call 不另计 —— 计数在 routes-llm）。
 */
import type { LlmReasoning, LlmSettings } from './settings.js';
import { LlmError, openAiCompatibleChat, type LlmMessage, type LlmToolSpec } from './llm-providers.js';
import { asRecord, errorMessage } from './util.js';

export interface LlmToolOutcome {
  /** 返回给模型的 JSON 字符串：模型要靠它知道这步成没成、下一步写什么 */
  content: string;
}

export interface LlmToolKit {
  setBlock(input: Record<string, unknown>): Promise<LlmToolOutcome>;
  suggest(input: Record<string, unknown>): Promise<LlmToolOutcome>;
}

export interface LlmAgentOptions {
  llm: LlmSettings;
  /** 本次请求的推理强度（D29）：来自请求体，缺省 off —— 不是 settings 里的字段 */
  reasoning: LlmReasoning;
  system: string;
  user: string;
  toolkit: LlmToolKit;
  /** 多轮对话的历史（纯文本 user/assistant 对），插在 system 与本次 user 之间 */
  history?: LlmMessage[];
  fetchImpl?: Parameters<typeof openAiCompatibleChat>[1];
}

export interface LlmAgentOutcome {
  summary: string;
  toolCalls: number;
  aborted: boolean;
  error?: { code: string; message: string };
}

export const LLM_TOOLS: LlmToolSpec[] = [
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
 * agent loop：每轮一次 chat；模型只要返回 tool_calls 就逐个执行并回填 tool 消息，
 * 直到它给出不带 tool_calls 的收尾回复、轮次用尽或总超时。
 */
export async function runLlmAgent(options: LlmAgentOptions): Promise<LlmAgentOutcome> {
  const messages: LlmMessage[] = [
    { role: 'system', content: options.system },
    ...(options.history ?? []),
    { role: 'user', content: options.user },
  ];
  // 总超时兜底：每次调用本身有 timeoutMs，这里再包一层"轮数 × 单次超时"的墙
  const deadline = Date.now() + options.llm.timeoutMs * (options.llm.maxToolRounds + 1);
  let summary = '';
  let toolCalls = 0;

  for (let round = 0; round <= options.llm.maxToolRounds; round += 1) {
    if (Date.now() > deadline) return { summary, toolCalls, aborted: true };

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
          tools: LLM_TOOLS,
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
      return { summary, toolCalls, aborted: false };
    }

    toolCalls += calls.length;
    messages.push({ role: 'assistant', content: result.content, tool_calls: calls });
    for (const call of calls) {
      const outcome = await dispatch(options.toolkit, call.function.name, parseArguments(call.function.arguments));
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
    }
  }

  return { summary, toolCalls, aborted: true };
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
  return { content: JSON.stringify({ ok: false, error: `未知工具 ${name}` }) };
}
