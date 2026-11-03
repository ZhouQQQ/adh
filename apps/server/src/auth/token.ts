import type { FastifyRequest } from 'fastify';

/** 从 Authorization 头或 query 参数取登录 token（WebSocket 只能用 query）。 */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }

  const raw = request.raw.url ?? '';
  const index = raw.indexOf('?');
  if (index >= 0) {
    const token = new URLSearchParams(raw.slice(index + 1)).get('token');
    if (token) return token;
  }
  return null;
}