import type { AiModelMessage, AiModelResult, AiToolCall } from './types.js';
import type { AiSettings } from '../settings/service.js';

/** OpenAI 兼容的 chat completions 客户端，支持 tools 和多模态图片。 */
export interface ChatToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface RawChoice {
  message?: {
    content?: string | null;
    tool_calls?: RawToolCall[];
  };
  finish_reason?: string;
}

interface RawResponse {
  choices?: RawChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

function parseArguments(raw?: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { raw };
  }
  // 有些模型会把 arguments 再编码一层字符串：'{"x":100}' → "{\"x\":100}"
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { raw };
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/** 调一次模型。失败时抛出可读错误，不把 apiKey 带进日志。 */
export async function chatCompletion(
  settings: AiSettings,
  messages: AiModelMessage[],
  tools: ChatToolSchema[],
  signal?: AbortSignal,
  options?: { maxTokens?: number },
): Promise<AiModelResult> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeout = AbortSignal.timeout(90_000);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: options?.maxTokens ?? 1024,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal: merged,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as RawResponse;
      if (parsed.error?.message) detail = parsed.error.message;
      else if (text) detail = text.slice(0, 500);
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(`模型请求失败（${response.status}）：${detail}`);
  }

  const body = (await response.json()) as RawResponse;
  const choice = body.choices?.[0];
  if (!choice?.message) {
    throw new Error('模型返回内容为空');
  }

  const toolCalls: AiToolCall[] = (choice.message.tool_calls ?? [])
    .map((call) => {
      const name = call.function?.name?.trim();
      if (!name) return null;
      return {
        id: call.id ?? name,
        name,
        args: parseArguments(call.function?.arguments),
      };
    })
    .filter((call): call is AiToolCall => call !== null);

  return {
    content: (choice.message.content ?? '').trim(),
    toolCalls,
    usage: {
      promptTokens: body.usage?.prompt_tokens,
      completionTokens: body.usage?.completion_tokens,
    },
  };
}