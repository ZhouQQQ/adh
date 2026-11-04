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

/** 安全键盘辅助层的布局，按设备持久化，多人共享。 */
export const SafeKeyboardLayoutSchema = z.object({
  x: z.number(),
  y: z.number(),
  height: z.number(),
  opacity: z.number(),
  /** password = 六位密码数字键盘；full = 全键盘。 */
  type: z.enum(['password', 'full']).default('password'),
});
export type SafeKeyboardLayout = z.infer<typeof SafeKeyboardLayoutSchema>;

/** 设备锁定信息，只有管理员能操作。 */
export const DeviceLockSchema = z.object({
  locked: z.boolean().default(false),
  /** 锁定人用户名。 */
  lockedBy: z.string().optional(),
  /** 锁定时间（毫秒），0 表示未锁定。 */
  lockedAt: z.number().default(0),
});

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
  /** CPU 厂商，如 联发科 / 高通。 */
  cpuVendor: z.string().optional(),
  /** CPU 型号，如 天玑 9400+。 */
  cpuModel: z.string().optional(),
  cpuCores: z.number().int().optional(),
  /** CPU 架构，如 arm64-v8a / arm64。 */
  cpuArch: z.string().optional(),
  /** SoC 代号，如 sm8250 / mt6893。 */
  cpuCode: z.string().optional(),
  /** 物理内存总量（MB）。 */
  memoryMb: z.number().int().optional(),
  /** 是否已 root / 越狱。检测不到时为 undefined。 */
  rooted: z.boolean().optional(),
  resolution: ResolutionSchema.optional(),
  status: DeviceStatusSchema.default('online'),
  /** 该设备当前可用的能力，如 scrcpy / wda / shell。 */
  capabilities: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** 当前正在控制设备的用户。 */
export const DeviceControlInfoSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string().optional(),
  /** 控制者角色：admin 不能接管 / 断开 superadmin。 */
  role: z.string().optional(),
  /** 开始控制的时间（毫秒） */
  since: z.number(),
});
export type DeviceControlInfo = z.infer<typeof DeviceControlInfoSchema>;

/** server 侧对外暴露的设备视图。 */
export const DeviceSummarySchema = DeviceInfoSchema.extend({
  ...DeviceLockSchema.shape,
  id: z.string(),
  agentId: z.string(),
  lastSeen: z.number(),
  /** 最近一次上线的毫秒时间戳，0 表示还没有上线记录。 */
  connectedAt: z.number().default(0),
  /** 累计被控制次数，用于按使用频率排序。 */
  useCount: z.number().int().default(0),
  /** 最近一次被控制的毫秒时间戳，0 表示从未使用。 */
  lastUsedAt: z.number().default(0),
  /** 缩略图最后更新时间，0 表示暂无。 */
  thumbnailAt: z.number().default(0),
  /** 缩略图来源：自动截图或手动上传。 */
  thumbnailSource: z.enum(['auto', 'manual']).default('auto'),
  /** 发布时间（毫秒时间戳），0 表示未设置。 */
  publishedAt: z.number().default(0),
  /** 支付密码等黑屏页面用的模拟键盘位置。 */
  safeKeyboard: SafeKeyboardLayoutSchema.optional(),
  /** iOS 设备 WDA 在本机使用的端口；多台 iOS 设备各不相同。 */
  wdaPort: z.number().int().optional(),
  /** 当前是否被某个控制会话占用。 */
  inUse: z.boolean().default(false),
  /** 正在控制的人；只读观看不算占用。 */
  control: DeviceControlInfoSchema.optional(),
  /** iOS 等无会话设备是否允许其他人查看；未设置时默认允许。 */
  allowViewers: z.boolean().optional(),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

/* ------------------------------------------------------------------ */
/* Agent                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* iOS 隧道（节点级，iOS 17+ 依赖 go-ios tunnel）                      */
/* ------------------------------------------------------------------ */

export const IosTunnelSchema = z.object({
  udid: z.string(),
  address: z.string().optional(),
  rsdPort: z.number().optional(),
});
export type IosTunnel = z.infer<typeof IosTunnelSchema>;

export const IosTunnelStatusSchema = z.object({
  running: z.boolean().default(false),
  tunnels: z.array(IosTunnelSchema).default([]),
  /** 最近一次启动失败的原因（Windows 常见：缺 wintun.dll / 非管理员权限）。 */
  error: z.string().optional(),
  updatedAt: z.number().default(0),
});
export type IosTunnelStatus = z.infer<typeof IosTunnelStatusSchema>;

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
  /** iOS 17+ 隧道状态，节点离线时保留最后一次上报值。 */
  tunnel: IosTunnelStatusSchema.optional(),
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

export const AgentStatusMessageSchema = z.object({
  t: z.literal('agent.status'),
  tunnel: IosTunnelStatusSchema,
});
export type AgentStatusMessage = z.infer<typeof AgentStatusMessageSchema>;

export const AgentToServerMessageSchema = z.discriminatedUnion('t', [
  HelloMessageSchema,
  DevicesSyncMessageSchema,
  AgentStatusMessageSchema,
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
  /** 节点级 iOS 隧道管理（iOS 17+）。 */
  'ios.tunnel.start',
  'ios.tunnel.stop',
  'ios.tunnel.status',
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

/** 控制者主动断开，其他观看者可以选择接管。 */
export const StreamControlReleasedSchema = z.object({
  t: z.literal('control.released'),
  username: z.string(),
  displayName: z.string().optional(),
});

/** 控制者是否允许其他人查看投屏。 */
export const StreamViewersSchema = z.object({
  t: z.literal('viewers'),
  allow: z.boolean(),
});

export const StreamAgentToViewerMessageSchema = z.discriminatedUnion('t', [
  StreamReadySchema,
  StreamRotatedSchema,
  StreamErrorSchema,
  StreamRoleSchema,
  StreamControlReleasedSchema,
  StreamViewersSchema,
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

/** 只写入设备剪贴板，不自动粘贴。 */
export const ViewerClipboardSchema = z.object({
  t: z.literal('clipboard'),
  text: z.string(),
});

/** 鼠标滚轮：x/y 为 0..1 归一化坐标，dx/dy 为滚动量。 */
export const ViewerScrollSchema = z.object({
  t: z.literal('scroll'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  dx: z.number().default(0),
  dy: z.number(),
});

export const ViewerRotateSchema = z.object({
  t: z.literal('rotate'),
});

/** 关闭 / 点亮屏幕（不锁屏）。 */
export const ViewerScreenSchema = z.object({
  t: z.literal('screen'),
  on: z.boolean(),
});

/** 拉下通知栏 / 快捷设置面板。 */
export const ViewerPanelSchema = z.object({
  t: z.literal('panel'),
  panel: z.enum(['notification', 'settings']).default('notification'),
});

/** viewer 发送的请求关键帧（背压恢复时使用）。 */
export const ViewerRequestIdrSchema = z.object({
  t: z.literal('requestIdr'),
});

export const ViewerToStreamMessageSchema = z.discriminatedUnion('t', [
  ViewerTouchSchema,
  ViewerKeySchema,
  ViewerTextSchema,
  ViewerClipboardSchema,
  ViewerScrollSchema,
  ViewerRotateSchema,
  ViewerScreenSchema,
  ViewerPanelSchema,
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