import type { AuthUser } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    /** 审计用：请求目标的名称，删除 / 修改前预取，避免日志里只剩 ID。 */
    auditSubject?: string;
  }
}