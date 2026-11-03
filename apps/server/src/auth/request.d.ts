import type { AuthUser } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}