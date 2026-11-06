import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpBackend } from './backend.js';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** stdio 与 Streamable HTTP 共用的工具定义。 */
export function createAdhMcpServer(
  backend: McpBackend,
  version: string,
): McpServer {
  const server = new McpServer(
    {
      name: 'adh-device-farm',
      title: 'ADH 设备农场',
      version,
      description:
        '分布式 Android / iOS 真机设备农场。提供设备发现、自然语言自动化任务、任务进度查询与取消能力。',
    },
    {
      instructions: [
        'ADH 设备农场用于远程操作真实 Android / iOS 设备，支持设备发现和纯视觉闭环的 AI 自动化任务。',
        '',
        '可用工具与能力：',
        '- list_devices：列出设备农场中的 Android / iOS 设备，默认只返回在线、未锁定、空闲设备；',
        '- get_device：查看单台设备的详细信息，包括分辨率、锁定状态和当前控制者；',
        '- run_task：用自然语言在指定或自动选择的空闲设备上创建 AI 任务，立即返回 taskId；',
        '- batch_task：一句话拆成多台设备的任务（并行或顺序），适合批量操作；',
        '- get_task：查询任务状态、执行步骤和最终结果；任务有录制时同时返回 replayUrl（可直接发给用户查看执行过程）；',
        '- list_tasks：列出当前 API Key 对应用户最近创建的任务；',
        '- cancel_task：取消排队中或执行中的任务；',
        '- cancel_all_tasks：停掉当前用户所有未完成任务。',
        '',
        '推荐流程：先用 list_devices 选择空闲设备，再用 run_task 下发任务；run_task 是异步的，之后每 1 秒调用 get_task 轮询，',
        '直到 status 变成 succeeded / failed / cancelled / timeout。任务执行可能需要几十秒，不要只查询一次就下结论。',
      ].join('\n'),
    },
  );

  server.registerTool(
    'list_devices',
    {
      title: '列出设备',
      description:
        '列出设备农场中的 Android / iOS 设备。默认只返回在线、未锁定、未被占用的设备，适合用来选择执行任务的设备。',
      inputSchema: {
        platform: z.enum(['android', 'ios']).optional(),
        tags: z.array(z.string()).optional(),
        idleOnly: z
          .boolean()
          .optional()
          .describe('默认 true：只返回空闲设备；false 返回全部在线设备'),
      },
    },
    async ({ platform, tags, idleOnly }) => {
      const devices = await backend.listDevices({ platform, tags, idleOnly });
      return text(
        devices.map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          status: device.status,
          tags: device.tags,
          osVersion: device.osVersion,
          idle: device.idle,
        })),
      );
    },
  );

  server.registerTool(
    'get_device',
    {
      title: '查看设备详情',
      description:
        '查询单台设备的详细信息：在线状态、分辨率、是否锁定、当前控制者（谁在用、从什么时候开始）。',
      inputSchema: {
        deviceId: z.string().min(1).describe('设备 id，可从 list_devices 获取'),
      },
    },
    async ({ deviceId }) => {
      const device = await backend.getDevice(deviceId);
      if (!device) throw new Error('设备不存在');
      return text(device);
    },
  );

  server.registerTool(
    'run_task',
    {
      title: '创建手机任务',
      description:
        '用自然语言创建一台手机上的 AI 任务或提问，例如「打开微信，进入小程序并登录」「当前页面有没有 UI 重叠」。立即返回 taskId；任务在后台执行，需要轮询 get_task 获取结果。',
      inputSchema: {
        instruction: z.string().min(1).describe('要执行的自然语言任务'),
        deviceId: z
          .string()
          .optional()
          .describe('指定设备 id；不传则自动选空闲设备'),
        platform: z.enum(['android', 'ios']).optional(),
        tags: z.array(z.string()).optional().describe('按设备标签筛选'),
        timeoutSec: z
          .number()
          .int()
          .min(30)
          .max(1800)
          .optional()
          .describe('任务超时秒数，默认 300'),
      },
    },
    async (args) => {
      const task = await backend.runTask(args);
      return text({
        task,
        hint: '任务已进入队列，请每秒轮询 get_task，直到 status 为 succeeded/failed/cancelled/timeout；结束后可用返回的 replayUrl 查看执行过程。',
      });
    },
  );

  server.registerTool(
    'batch_task',
    {
      title: '批量任务',
      description:
        '把一句话拆成多台设备的任务。用户说「一起 / 都 / 每台」时用这个；会自动判断并行还是顺序执行，并返回每台设备对应的任务 id。',
      inputSchema: {
        instruction: z.string().min(1).describe('要执行的自然语言任务'),
        deviceIds: z
          .array(z.string())
          .optional()
          .describe('候选设备 id 列表；不传则用全部在线空闲设备'),
      },
    },
    async (args) => {
      const result = await backend.batchTask(args);
      return text({
        ...((result as object) ?? {}),
        hint: '每个任务都要分别轮询 get_task；批量任务可用 cancel_all_tasks 一次性停止。',
      });
    },
  );

  server.registerTool(
    'get_task',
    {
      title: '查询任务',
      description:
        '查询任务状态、执行步骤和最终结果。status: queued/running/succeeded/failed/cancelled/timeout。任务有执行录制时，返回的 task 里会带 replayUrl，可以直接发给用户用浏览器查看每一步画面和动作。',
      inputSchema: {
        taskId: z.string().min(1),
      },
    },
    async ({ taskId }) => {
      const task = await backend.getTask(taskId);
      if (!task) throw new Error('任务不存在');
      return text({ task });
    },
  );

  server.registerTool(
    'list_tasks',
    {
      title: '列出最近任务',
      description: '列出当前 API Key 对应用户最近创建的任务。',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ limit }) => {
      return text({ tasks: await backend.listTasks(limit) });
    },
  );

  server.registerTool(
    'cancel_task',
    {
      title: '取消任务',
      description: '取消一个排队中或执行中的任务。',
      inputSchema: {
        taskId: z.string().min(1),
      },
    },
    async ({ taskId }) => text(await backend.cancelTask(taskId)),
  );

  server.registerTool(
    'cancel_all_tasks',
    {
      title: '停止全部任务',
      description:
        '停掉当前用户所有排队中 / 执行中的任务，用于批量任务中途放弃。',
      inputSchema: {},
    },
    async () => text(await backend.cancelAllTasks()),
  );

  return server;
}