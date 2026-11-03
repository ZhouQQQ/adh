/**
 * 把写操作翻译成可读的审计动作，避免日志里出现一堆接口路径。
 * 设备控制 / 安装 / 文件操作已经在设备日志里，这里不重复记录。
 */
export function describeAudit(input: {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, unknown>;
}): { action: string; detail: string } | null {
  const { method, path, body } = input;
  const payload = (body ?? {}) as {
    name?: string;
    package?: string;
    publishedAt?: number;
    safeKeyboard?: unknown;
    displayName?: string;
    role?: string;
    enabled?: boolean;
    password?: string;
  };

  const suffix = payload.name ? `「${payload.name}」` : '';

  if (method === 'POST' && path === '/api/agents') {
    return { action: 'agent.create', detail: `创建节点${suffix}` };
  }
  if (method === 'PATCH' && /^\/api\/agents\/[^/]+$/.test(path)) {
    return { action: 'agent.update', detail: `重命名节点${suffix}` };
  }
  if (method === 'DELETE' && /^\/api\/agents\/[^/]+$/.test(path)) {
    return { action: 'agent.delete', detail: '删除节点' };
  }
  if (method === 'POST' && /^\/api\/agents\/[^/]+\/rotate$/.test(path)) {
    return { action: 'agent.rotate', detail: '重置节点接入 Key' };
  }

  if (method === 'PATCH' && /^\/api\/devices\/[^/]+$/.test(path)) {
    const fields: string[] = [];
    if (payload.publishedAt !== undefined) fields.push('发布时间');
    if (payload.safeKeyboard !== undefined) fields.push('安全键盘位置');
    return {
      action: 'device.update',
      detail: `修改设备${fields.length > 0 ? `（${fields.join('、')}）` : ''}`,
    };
  }
  if (method === 'DELETE' && /^\/api\/devices\/[^/]+$/.test(path)) {
    return { action: 'device.delete', detail: '删除设备' };
  }
  if (method === 'POST' && /^\/api\/devices\/[^/]+\/thumbnail$/.test(path)) {
    return { action: 'device.thumbnail', detail: '上传设备图片' };
  }

  if (method === 'POST' && path === '/api/packages') {
    const raw = input.headers?.['x-file-name'];
    let fileName = '';
    if (typeof raw === 'string' && raw) {
      try {
        fileName = decodeURIComponent(raw);
      } catch {
        fileName = raw;
      }
    }
    return {
      action: 'package.upload',
      detail: `上传安装包${fileName ? `「${fileName}」` : ''}`,
    };
  }
  if (method === 'PATCH' && /^\/api\/packages\/[^/]+$/.test(path)) {
    return { action: 'package.rename', detail: `重命名安装包${suffix}` };
  }
  if (method === 'DELETE' && /^\/api\/packages\/[^/]+$/.test(path)) {
    return { action: 'package.delete', detail: '删除安装包' };
  }

  return null;
}