import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/** Parses `body` with `schema`, replying 400 on failure. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply) {
  const result = schema.safeParse(body);
  if (!result.success) {
    reply.code(400).send({ error: 'invalid_body', issues: result.error.issues });
    return undefined;
  }
  return result.data as z.infer<T>;
}
