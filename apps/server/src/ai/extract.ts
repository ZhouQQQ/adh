import type { Logger } from '../log.js';
import type { AiSettings } from '../settings/service.js';
import { chatCompletion } from './client.js';
import type { AiScreenshot } from './device-control.js';

/**
 * 查询任务的最终「读屏」步骤。
 *
 * 和主循环不同，这里不再给模型任何工具，只让它看着截图回答问题：
 * - 输出是语义结论，不是 OCR 文本清单；
 * - 只提取和用户问题相关的字段；
 * - 模型返回空内容时也能靠 JSON 解析拿到兜底答案。
 */
const EXTRACT_SYSTEM_PROMPT = [
  '你是一个界面信息提取助手。你会看到一张手机截图和用户的问题。',
  '你的任务是从截图里找到回答该问题所需的信息，用简洁的中文给出结论。',
  '',
  '规则：',
  '- 只提取与问题相关的信息，不要罗列屏幕上的其他文字，不要输出坐标、像素、OCR 清单或推理过程。',
  '- 文字内容原样引用；图片、语音、表情、文件等注明类型，并描述与问题相关的部分。',
  '- 画面上看不到、或无法确定时，found 设为 false，并在 answer 里直接说明看不到什么，不要猜测。',
  '- 如果用户问的是「最近 / 最新 / 第一条」，只回答最靠前的那一条，不要列出全部。',
  '- 如果截图是锁屏、息屏或全黑，找不到内容，found 设为 false，并在 answer 里说明设备已锁屏/息屏、需要先解锁，不要猜测画面内容。',
  '',
  '只输出一个 JSON 对象，不要输出 markdown 代码块或额外说明：',
  '{"found": true, "answer": "给用户看的 1~3 句中文结论", "fields": {"source": "页面或会话名", "time": "时间", "sender": "发送者", "type": "文字/图片/语音/表情", "content": "原样内容"}}',
].join('\n');

export interface ExtractAnswerInput {
  settings: AiSettings;
  /** 用户的原始问题。 */
  instruction: string;
  /** 已经执行过的动作，帮助模型理解当前停留在哪一层页面。 */
  transcript: string[];
  /** 当前屏幕截图。 */
  shot: AiScreenshot;
  signal: AbortSignal;
  logger?: Logger;
  deviceId?: string;
}

interface ExtractedAnswer {
  found?: boolean;
  answer?: string;
  fields?: Record<string, unknown>;
}

function parseExtractedAnswer(text: string): ExtractedAnswer | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as ExtractedAnswer;
  } catch {
    return null;
  }
}

const FIELD_LABELS: Array<[string, string]> = [
  ['source', '来源'],
  ['time', '时间'],
  ['sender', '发送者'],
  ['type', '类型'],
  ['content', '内容'],
];

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const lines = FIELD_LABELS.flatMap(([key, label]) => {
    const value = fields[key];
    if (typeof value !== 'string' || !value.trim()) return [];
    return [`${label}：${value.trim()}`];
  });
  return lines.join('\n');
}

/** 从 JSON、代码块或纯文本里取出最终要回复用户的内容。 */
function toReply(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const parsed = parseExtractedAnswer(text);
  if (!parsed) return text;
  const answer =
    typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (answer) return answer;
  return formatFields(parsed.fields);
}

/**
 * 让模型基于最新截图回答用户的问题。
 * 返回空字符串表示模型没有提取到任何可用内容。
 */
export async function extractAnswerFromScreen(
  input: ExtractAnswerInput,
): Promise<string> {
  const executed = input.transcript.length
    ? [
        '',
        '已执行的操作：',
        ...input.transcript.slice(-10).map((item, index) => `${index + 1}. ${item}`),
      ].join('\n')
    : '';
  const prompt = [
    `用户的问题：${input.instruction}`,
    executed,
    '',
    '这是执行后的最新截图。请按要求只输出 JSON。',
  ].join('\n');

  const start = Date.now();
  const result = await chatCompletion(
    input.settings,
    [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${input.shot.base64}`,
              detail: 'high',
            },
          },
        ],
      },
    ],
    [],
    input.signal,
    { maxTokens: 700, toolChoice: 'none' },
  );
  input.logger?.info(
    {
      deviceId: input.deviceId,
      ms: Date.now() - start,
      chars: result.content.length,
    },
    'ai extract answer',
  );
  return toReply(result.content);
}