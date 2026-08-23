/**
 * OpenAPI document generated from the routes themselves: every route passes a
 * {@link RouteDoc} in its Fastify `config.doc` (summary, required permission, zod body /
 * response schemas), an `onRoute` hook collects them at registration time, and
 * `GET /api/openapi.json` renders the document with zod's own JSON-schema export — so
 * the spec can never drift from the contracts in `@cc/shared` or from the routes.
 *
 * Security is expressed as two schemes the desk and integrations use: the session
 * cookie and `Authorization: Bearer ak_…` API keys; each operation lists the
 * permission it needs in `x-permission` and its description.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import type { Permission } from '@cc/shared';
import type { FastifyInstance } from 'fastify';
import { type ZodType, z } from 'zod';

/** Who may call a route: a permission, or one of the non-permission gates. */
export type Access = Permission | 'public' | 'session' | 'admin-email' | 'internal';

/** What a route tells the OpenAPI generator through `config.doc`. */
export type RouteDoc = {
  /** One line, imperative ("Accept the offer ringing this agent"). */
  summary: string;
  /** Required permission or gate; see {@link Access}. */
  access: Access;
  /** Request body schema (JSON). */
  body?: ZodType;
  /** Successful response schema; omitted = unspecified JSON. */
  response?: ZodType;
  /** Error codes the route answers with, e.g. `['404 not_found']`. */
  errors?: string[];
  /** Tag (group) in the document; defaults to the first path segment after `/api`. */
  tag?: string;
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Documentation for `GET /api/openapi.json`; routes without it are not listed. */
    doc?: RouteDoc;
  }
}

type Collected = { method: string; url: string; doc: RouteDoc };

const gateText: Record<Exclude<Access, Permission>, string> = {
  public: 'No authentication (embed key in the body).',
  session: 'Any signed-in user or API key.',
  'admin-email': 'A signed-in platform admin (`ADMIN_EMAILS`).',
  internal: 'The AI worker: `x-internal-secret` header.',
};

/**
 * Builds the OpenAPI 3.1 document for the collected routes.
 *
 * @param routes - What the `onRoute` hook gathered.
 * @param info - Title and version (from the root `package.json`).
 */
function buildOpenApi(routes: Collected[], info: { title: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { method, url, doc } of routes) {
    const path = url.replace(/:(\w+)/g, '{$1}');
    const params = [...url.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const isPermission = !(doc.access in gateText);
    const op: Record<string, unknown> = {
      summary: doc.summary,
      description: isPermission
        ? `Requires the \`${doc.access}\` permission (role or API key).`
        : gateText[doc.access as Exclude<Access, Permission>],
      tags: [doc.tag ?? url.split('/')[2] ?? 'api'],
      'x-permission': doc.access,
      ...(params.length ? { parameters: params } : {}),
      ...(doc.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: z.toJSONSchema(doc.body) } },
            },
          }
        : {}),
      responses: {
        200: doc.response
          ? {
              description: 'OK',
              content: { 'application/json': { schema: z.toJSONSchema(doc.response) } },
            }
          : { description: 'OK' },
        ...Object.fromEntries(
          (doc.errors ?? []).map((e) => {
            const [code, ...rest] = e.split(' ');
            return [code, { description: rest.join(' ') || 'error' }];
          }),
        ),
      },
      security:
        doc.access === 'public' || doc.access === 'internal'
          ? []
          : [{ cookieAuth: [] }, { bearerAuth: [] }],
    };
    (paths[path] ??= {})[method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      ...info,
      description: 'Patchbay Contact Center public API. Every desk operation is here.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key `ak_…`' },
      },
    },
    paths,
  };
}

/**
 * Collects documented routes as they are registered and serves the document at
 * `GET /api/openapi.json`. Call before registering the route plugins.
 */
export function registerOpenApi(app: FastifyInstance, info: { title: string; version: string }) {
  const routes: Collected[] = [];
  app.addHook('onRoute', (route) => {
    const doc = route.config?.doc;
    if (!doc) return;
    for (const method of [route.method].flat()) routes.push({ method, url: route.url, doc });
  });
  app.get(
    '/api/openapi.json',
    {
      config: { doc: { summary: 'This document', access: 'public', tag: 'meta' } },
    },
    async () => buildOpenApi(routes, info),
  );
}
