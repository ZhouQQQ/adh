/** AI 助手对外的事件与消息类型。 */

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** SSE 推给前端的事件。 */
export type AiEvent =
  | { type: 'status'; message: string }
  | { type: 'saved'; role: 'user' | 'assistant'; id: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; detail: string }
  | { type: 'reply'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface AiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AiModelResult {
  content: string;
  toolCalls: AiToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

/** OpenAI 兼容的消息格式，仅覆盖本项目用到的部分。 */
export type AiModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | AiContentPart[] }
  | { role: 'assistant'; content: string | null }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AiContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
    };