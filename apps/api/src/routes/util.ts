/**
 * Helpers shared by the route files.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/**
 * Parses `body` with `schema`, replying 400 on failure.
 *
 * The convention in every route: `const body = parseBody(...); if (!body) return undefined;`.
 * Returning `undefined` after `reply.send()` tells Fastify the reply was already sent.
 * The 400 payload is `{ error: 'invalid_body', issues }` where `issues` are zod's.
 *
 * @param schema - Zod schema; defaults inside it are applied (e.g. `queue` defaults to `support`).
 * @param body - Raw `request.body` (may be `undefined` for empty bodies; pass `?? {}` then).
 * @param reply - Used to send the 400.
 * @returns The parsed, typed body, or `undefined` when the 400 was sent.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply) {
  const result = schema.safeParse(body);
  if (!result.success) {
    reply.code(400).send({ error: 'invalid_body', issues: result.error.issues });
    return undefined;
  }
  return result.data as z.infer<T>;
}
