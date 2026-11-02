import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* 基础类型                                                            */
/* ------------------------------------------------------------------ */

export const PlatformSchema = z.enum(['android', 'ios']);
export type Platform = z.infer<typeof PlatformSchema>;

export const DeviceStatusSchema = z.enum(['online', 'offline', 'unauthorized']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const AgentCapabilitySchema = z.enum(['android', 'ios', 'scrcpy', 'wda']);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const ResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

/** agent 上报的原始设备信息。 */
export const DeviceInfoSchema = z.object({
  udid: z.string().min(1),
  platform: PlatformSchema,
  name: z.string(),
  /** 厂商市场名称，如 "iQOO Z10 Turbo+"；取不到时回退到型号。 */
  marketName: z.string().optional(),
  model: z.string().optional(),
  brand: z.string().optional(),
  osVersion: z.string().optional(),
  /** Android API level，用于精确筛版本。 */
  sdk: z.number().int().optional(),
  /** CPU 展示名，如 "Qualcomm SM8550"。 */
  cpu: z.string().optional(),
  cpuCores: z.number().int().optional(),
  /** 物理内存总量（MB）。 */
  memoryMb: z.number().int().optional(),
  resolution: ResolutionSchema.optional(),
  status: DeviceStatusSchema.default('online'),
  /** 该设备当前可用的能力，如 scrcpy / wda / shell。 */
  capabilities: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** server 侧对外暴露的设备视图。 */
export const DeviceSummarySchema = DeviceInfoSchema.extend({
  id: z.string(),
  agentId: z.string(),
  lastSeen: z.number(),
  /** 缩略图最后更新时间，0 表示暂无。 */
  thumbnailAt: z.number().default(0),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

/* ------------------------------------------------------------------ */
/* Agent                                                               */
/* ------------------------------------------------------------------ */

export const AgentRuntimeInfoSchema = z.object({
  name: z.string().min(1),
  os: z.string(),
  arch: z.string(),
  version: z.string(),
  capabilities: z.array(AgentCapabilitySchema).default([]),
  protocolVersion: z.number().int().default(1),
});
export type AgentRuntimeInfo = z.infer<typeof AgentRuntimeInfoSchema>;

export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** agent 上报的宿主机名称，只读。 */
  hostName: z.string().optional(),
  os: z.string(),
  arch: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()),
  /** token 掩码，用于界面展示。 */
  keyPreview: z.string(),
  deviceCount: z.number().int().default(0),
  lastSeen: z.number(),
  createdAt: z.number().default(0),
  online: z.boolean(),
  /** 已创建但从未接入过。 */
  pending: z.boolean().default(false),
  /** server 自带的本机 Agent。 */
  builtin: z.boolean().default(false),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

/** 创建 Agent 的响应，key 只在创建/重置时返回一次。 */
export const CreateAgentResponseSchema = z.object({
  agent: AgentSummarySchema,
  key: z.string(),
});
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

/** 详情接口返回完整 key，便于随时查看接入命令。 */
export const AgentDetailSchema = z.object({
  agent: AgentSummarySchema,
  key: z.string(),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

export const UpdateAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(40),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBodySchema>;

/* ------------------------------------------------------------------ */
/* Agent 主通道：agent -> server                                       */
/* ------------------------------------------------------------------ */

export const HelloMessageSchema = z.object({
  t: z.literal('hello'),
  token: z.string().min(1),
  agent: AgentRuntimeInfoSchema,
});

export const DevicesSyncMessageSchema = z.object({
  t: z.literal('devices.sync'),
  add: z.array(DeviceInfoSchema).default([]),
  remove: z.array(z.string()).default([]),
  update: z
    .array(
      z.object({
        udid: z.string().min(1),
        patch: DeviceInfoSchema.partial(),
      }),
    )
    .default([]),
});

export const PongMessageSchema = z.object({
  t: z.literal('pong'),
  ts: z.number(),
});

export const CmdResultMessageSchema = z.object({
  t: z.literal('cmd.result'),
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type CmdResultMessage = z.infer<typeof CmdResultMessageSchema>;

export const AgentToServerMessageSchema = z.discriminatedUnion('t', [
  HelloMessageSchema,
  DevicesSyncMessageSchema,
  PongMessageSchema,
  CmdResultMessageSchema,
]);
export type AgentToServerMessage = z.infer<typeof AgentToServerMessageSchema>;

/* ------------------------------------------------------------------ */
/* Agent 主通道：server -> agent                                       */
/* ------------------------------------------------------------------ */

export const WelcomeMessageSchema = z.object({
  t: z.literal('welcome'),
  agentId: z.string(),
  heartbeatSec: z.number(),
  serverVersion: z.string(),
  /** 首次用注册码接入时下发的新 token，agent 需持久化。 */
  token: z.string().optional(),
});

export const PingMessageSchema = z.object({
  t: z.literal('ping'),
  ts: z.number(),
});

export const DeviceActionSchema = z.enum([
  'screen.start',
  'screen.stop',
  'input.touch',
  'input.key',
  'input.text',
  'input.rotate',
  'screenshot',
  'app.install',
  'app.uninstall',
  'app.list',
  'app.launch',
  'shell',
  'logcat.start',
  'logcat.stop',
  'device.reboot',
]);
export type DeviceAction = z.infer<typeof DeviceActionSchema>;

export const CmdMessageSchema = z.object({
  t: z.literal('cmd'),
  id: z.string(),
  deviceId: z.string().optional(),
  action: DeviceActionSchema,
  params: z.unknown().optional(),
});

export const StopMessageSchema = z.object({
  t: z.literal('stop'),
  reason: z.string().optional(),
});

export const ServerToAgentMessageSchema = z.discriminatedUnion('t', [
  WelcomeMessageSchema,
  PingMessageSchema,
  CmdMessageSchema,
  StopMessageSchema,
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessageSchema>;

/* ------------------------------------------------------------------ */
/* 投屏流通道（/ws/stream/:sessionId）                                  */
/* ------------------------------------------------------------------ */

export const StreamCodecSchema = z.enum(['h264', 'jpeg']);
export type StreamCodec = z.infer<typeof StreamCodecSchema>;

/** agent -> viewer：流就绪，携带解码所需参数。 */
export const StreamReadySchema = z.object({
  t: z.literal('ready'),
  sessionId: z.string(),
  platform: PlatformSchema,
  codec: StreamCodecSchema,
  /** WebCodecs 用的 codec 字符串，如 avc1.640028 */
  videoCodec: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rotation: z.number().int().default(0),
  /** H.264 的 avcC description，base64 编码。 */
  description: z.string().optional(),
});
export type StreamReady = z.infer<typeof StreamReadySchema>;

export const StreamRotatedSchema = z.object({
  t: z.literal('rotated'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rotation: z.number().int().default(0),
  description: z.string().optional(),
});

export const StreamErrorSchema = z.object({
  t: z.literal('error'),
  message: z.string(),
});

/** 告诉 viewer 当前是否持有控制权。 */
export const StreamRoleSchema = z.object({
  t: z.literal('role'),
  controller: z.boolean(),
});

export const StreamAgentToViewerMessageSchema = z.discriminatedUnion('t', [
  StreamReadySchema,
  StreamRotatedSchema,
  StreamErrorSchema,
  StreamRoleSchema,
]);
export type StreamAgentToViewerMessage = z.infer<
  typeof StreamAgentToViewerMessageSchema
>;

/** viewer -> agent：触摸。坐标归一化到 0..1。 */
export const ViewerTouchSchema = z.object({
  t: z.literal('touch'),
  phase: z.enum(['began', 'moved', 'ended']),
  x: z.number(),
  y: z.number(),
  pointerId: z.number().int().default(0),
  pressure: z.number().default(1),
});

export const ViewerKeySchema = z.object({
  t: z.literal('key'),
  /** 平台无关的按键名：home / back / recent / power / volumeUp / volumeDown / mute。 */
  key: z.enum([
    'home',
    'back',
    'recent',
    'power',
    'volumeUp',
    'volumeDown',
    'mute',
  ]),
});

export const ViewerTextSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
});

export const ViewerRotateSchema = z.object({
  t: z.literal('rotate'),
});

/** viewer 发送的请求关键帧（背压恢复时使用）。 */
export const ViewerRequestIdrSchema = z.object({
  t: z.literal('requestIdr'),
});

export const ViewerToStreamMessageSchema = z.discriminatedUnion('t', [
  ViewerTouchSchema,
  ViewerKeySchema,
  ViewerTextSchema,
  ViewerRotateSchema,
  ViewerRequestIdrSchema,
]);
export type ViewerToStreamMessage = z.infer<typeof ViewerToStreamMessageSchema>;

/* ------------------------------------------------------------------ */
/* Web 事件通道（/ws/web）                                              */
/* ------------------------------------------------------------------ */

export const WebEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('agent.updated'), agent: AgentSummarySchema }),
  z.object({ t: z.literal('agent.removed'), agentId: z.string() }),
  z.object({ t: z.literal('device.updated'), device: DeviceSummarySchema }),
  z.object({ t: z.literal('device.removed'), deviceId: z.string() }),
]);
export type WebEvent = z.infer<typeof WebEventSchema>;

/* ------------------------------------------------------------------ */
/* 解析辅助                                                            */
/* ------------------------------------------------------------------ */

export function parseAgentMessage(raw: string): AgentToServerMessage | null {
  try {
    const parsed = AgentToServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerToAgentMessage | null {
  try {
    const parsed = ServerToAgentMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseViewerMessage(raw: string): ViewerToStreamMessage | null {
  try {
    const parsed = ViewerToStreamMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}