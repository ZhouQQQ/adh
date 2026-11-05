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
  const server = new McpServer({
    name: 'adh-device-hub',
    version,
  });

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
        hint: '任务已进入队列，请每秒轮询 get_task，直到 status 为 succeeded/failed/cancelled/timeout。',
      });
    },
  );

  server.registerTool(
    'get_task',
    {
      title: '查询任务',
      description:
        '查询任务状态、执行步骤和最终结果。status: queued/running/succeeded/failed/cancelled/timeout。',
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

  return server;
}