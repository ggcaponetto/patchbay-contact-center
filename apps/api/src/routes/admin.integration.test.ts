import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { buildServer } from '../server.ts';
import { createCall, getCall } from '../services/calls.ts';
import {
  bootstrapUser,
  createInvite,
  createTenant,
  listInvites,
  membershipsOf,
  originAllowed,
  resolveEmbedKey,
  slugify,
  updateSettings,
} from '../services/tenants.ts';
import { createUser, dbAvailable, fakeLiveKit, freshDb, resetDb, testServer } from '../testing.ts';

const hasDb = await dbAvailable();

describe('pure helpers', () => {
  it('slugifies names', () => {
    expect(slugify('Acme Corp!')).toBe('acme-corp');
    expect(slugify('***')).toBe('tenant');
  });
  it('checks origins', () => {
    expect(originAllowed([], undefined)).toBe(true);
    expect(originAllowed(['https://a.com'], 'https://a.com')).toBe(true);
    expect(originAllowed(['https://a.com'], 'https://b.com')).toBe(false);
    expect(originAllowed(['https://a.com'], undefined)).toBe(false);
  });
});

describe.skipIf(!hasDb)('tenants & admin routes', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof testServer>>['app'];
  let as: Awaited<ReturnType<typeof testServer>>['as'];

  beforeAll(async () => {
    ({ db, close } = await freshDb());
    ({ app, as } = await testServer(db, ['boss@example.com']));
  });
  afterAll(async () => {
    await app.close();
    await close();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  it('bootstraps admins with a tenant and honours invites', async () => {
    const boss = await createUser(db, 'boss@example.com', 'Boss');
    await bootstrapUser(db, boss, ['boss@example.com']);
    const ms = await membershipsOf(db, boss.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.role).toBe('supervisor');

    // unlisted user gets nothing
    const nobody = await createUser(db, 'nobody@example.com');
    await bootstrapUser(db, nobody, ['boss@example.com']);
    expect(await membershipsOf(db, nobody.id)).toHaveLength(0);

    // invited user becomes an agent on first login
    const res = await as(boss).inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { email: 'Agent@Example.com', role: 'agent' },
    });
    expect(res.statusCode).toBe(200);
    const agent = await createUser(db, 'agent@example.com');
    await bootstrapUser(db, agent, []);
    expect((await membershipsOf(db, agent.id))[0]?.role).toBe('agent');
    // bootstrapping twice is idempotent
    await bootstrapUser(db, agent, []);
    expect(await membershipsOf(db, agent.id)).toHaveLength(1);
  });

  it('needs a session resolver and reads ADMIN_EMAILS from the environment', async () => {
    const livekit = fakeLiveKit().livekit;
    await expect(buildServer({ db, livekit })).rejects.toThrow(/getSession/);
    await expect(
      buildServer({ db, livekit, getSession: async () => null, internalSecret: '' }),
    ).rejects.toThrow(/INTERNAL_API_SECRET/);
    process.env.ADMIN_EMAILS = ' Env@Example.com ,';
    const { app: envApp } = await buildServer({
      db,
      livekit,
      internalSecret: 's',
      getSession: async () => envUser,
    });
    const envUser = await createUser(db, 'env@example.com', '');
    await bootstrapUser(db, envUser, ['env@example.com']);
    const me = await envApp.inject({ url: '/api/me' });
    expect(me.json().isAdmin).toBe(true);
    expect(me.json().memberships[0].tenantName).toContain("env@example.com's");
    await envApp.close();
    delete process.env.ADMIN_EMAILS;
  });

  it('validates bodies and tenant headers', async () => {
    const boss = await createUser(db, 'boss@example.com');
    const t = await createTenant(db, 'T', boss.id);
    const hdr = { 'x-tenant-id': t.id };
    for (const [url, payload] of [
      ['/api/admin/invites', { email: 'not-an-email', role: 'agent' }],
      ['/api/admin/queues', { key: '' }],
      ['/api/admin/embed-keys', { label: 'x', allowedOrigins: ['nope'] }],
    ] as const) {
      const res = await as(boss).inject({ method: 'POST', url, headers: hdr, payload });
      expect(res.statusCode, url).toBe(400);
    }
    const unknownTenant = await as(boss).inject({
      url: '/api/admin/tenant',
      headers: { 'x-tenant-id': 'nope' },
    });
    expect(unknownTenant.statusCode).toBe(403);
    expect(await updateSettings(db, 'missing', {})).toBeUndefined();
    await createInvite(db, t.id, 'x@example.com', 'agent');
    await createInvite(db, t.id, 'x@example.com', 'supervisor');
    const invites = await listInvites(db, t.id);
    expect(invites).toHaveLength(1);
    expect(invites[0]!.role).toBe('supervisor');
  });

  it('rejects anonymous and non-supervisor access', async () => {
    expect((await as(null).inject({ url: '/api/me' })).statusCode).toBe(401);
    const boss = await createUser(db, 'boss@example.com');
    await createTenant(db, 'T', boss.id);
    const agent = await createUser(db, 'a@example.com');
    expect((await as(agent).inject({ url: '/api/admin/tenant' })).statusCode).toBe(403);
    expect((await as(agent).inject({ url: '/api/me' })).json().isAdmin).toBe(false);
    const created = await as(agent).inject({
      method: 'POST',
      url: '/api/admin/tenants',
      payload: { name: 'X' },
    });
    expect(created.statusCode).toBe(403);
    const me = await as(boss).inject({ url: '/api/me' });
    expect(me.json().isAdmin).toBe(true);
    expect(me.json().memberships).toHaveLength(1);
  });

  it('issues API keys that act as the tenant with exactly their permissions', async () => {
    const boss = await createUser(db, 'boss@example.com');
    const tenantId = (await createTenant(db, 'T', boss.id)).id;
    const bad = await as(boss).inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      payload: { name: 'crm', permissions: ['nope'] },
    });
    expect(bad.statusCode).toBe(400);
    const created = await as(boss).inject({
      method: 'POST',
      url: '/api/admin/api-keys',
      payload: { name: 'crm', permissions: ['calls:read'] },
    });
    const { id, secret, prefix } = created.json();
    expect(secret).toMatch(/^ak_[0-9a-f]{64}$/);
    expect(prefix).toBe(secret.slice(0, 12));
    expect(created.json()).not.toHaveProperty('hash');

    const bearer = { authorization: `Bearer ${secret}` };
    const me = await as(null).inject({ url: '/api/me', headers: bearer });
    expect(me.json()).toMatchObject({
      user: { id: `key:${id}`, name: 'crm' },
      permissions: ['calls:read'],
      memberships: [],
    });
    expect((await as(null).inject({ url: '/api/desk/calls', headers: bearer })).statusCode).toBe(
      200,
    );
    expect((await as(null).inject({ url: '/api/desk/agents', headers: bearer })).json()).toEqual(
      [],
    );
    // not granted: state changes, supervision, tenant admin
    expect(
      (
        await as(null).inject({
          method: 'POST',
          url: '/api/desk/state',
          headers: bearer,
          payload: { state: 'ready' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await as(null).inject({ url: '/api/admin/tenant', headers: bearer })).statusCode).toBe(
      403,
    );
    // unknown / malformed keys are 401
    expect(
      (
        await as(null).inject({
          url: '/api/desk/calls',
          headers: { authorization: 'Bearer ak_00' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await as(null).inject({ url: '/api/desk/calls', headers: { authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401);

    const list = await as(boss).inject({ url: '/api/admin/api-keys' });
    expect(list.json()).toMatchObject([{ id, name: 'crm', prefix, revokedAt: null }]);
    expect(list.json()[0].lastUsedAt).not.toBeNull();
    const revokeUrl = `/api/admin/api-keys/${id}/revoke`;
    expect((await as(boss).inject({ method: 'POST', url: revokeUrl })).json()).toEqual({
      ok: true,
    });
    expect((await as(boss).inject({ method: 'POST', url: revokeUrl })).statusCode).toBe(404);
    expect((await as(null).inject({ url: '/api/desk/calls', headers: bearer })).statusCode).toBe(
      401,
    );
    expect(
      (await as(boss).inject({ url: '/api/admin/api-keys' })).json()[0].revokedAt,
    ).not.toBeNull();
    // deleting removes the row (works on revoked keys too); a second delete is a 404
    expect(
      (await as(boss).inject({ method: 'DELETE', url: `/api/admin/api-keys/${id}` })).json(),
    ).toEqual({ ok: true });
    expect(
      (await as(boss).inject({ method: 'DELETE', url: `/api/admin/api-keys/${id}` })).statusCode,
    ).toBe(404);
    expect((await as(boss).inject({ url: '/api/admin/api-keys' })).json()).toEqual([]);
    // keys are tenant-scoped: another tenant's supervisor cannot revoke them
    const other = await createUser(db, 'other@example.com');
    await createTenant(db, 'O', other.id);
    const theirs = (
      await as(boss).inject({
        method: 'POST',
        url: '/api/admin/api-keys',
        payload: { name: 'k', permissions: ['tenant:read'] },
      })
    ).json();
    expect(
      (await as(other).inject({ method: 'DELETE', url: `/api/admin/api-keys/${theirs.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await as(other).inject({ method: 'POST', url: `/api/admin/api-keys/${theirs.id}/revoke` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await as(null).inject({
          url: '/api/admin/tenant',
          headers: { authorization: `Bearer ${theirs.secret}` },
        })
      ).json().id,
    ).toBe(tenantId);
  });

  it('manages settings, queues, members and embed keys', async () => {
    const boss = await createUser(db, 'boss@example.com');
    const t = (
      await as(boss).inject({
        method: 'POST',
        url: '/api/admin/tenants',
        payload: { name: 'Acme' },
      })
    ).json();
    expect(t.slug.startsWith('acme-')).toBe(true);
    const bad = await as(boss).inject({ method: 'POST', url: '/api/admin/tenants', payload: {} });
    expect(bad.statusCode).toBe(400);

    const hdr = { 'x-tenant-id': t.id };
    const tenant = (await as(boss).inject({ url: '/api/admin/tenant', headers: hdr })).json();
    expect(tenant.settings.routingMode).toBe('ai-first');

    const patched = await as(boss).inject({
      method: 'PATCH',
      url: '/api/admin/tenant/settings',
      headers: hdr,
      payload: { routingMode: 'human-first', handoff: { aiBehavior: 'listen' } },
    });
    expect(patched.json().settings).toMatchObject({
      routingMode: 'human-first',
      handoff: { aiBehavior: 'listen' },
    });
    const invalid = await as(boss).inject({
      method: 'PATCH',
      url: '/api/admin/tenant/settings',
      headers: hdr,
      payload: { routingMode: 'nope' },
    });
    expect(invalid.statusCode).toBe(400);

    let queues = (await as(boss).inject({ url: '/api/admin/queues', headers: hdr })).json();
    expect(queues.map((q: { key: string }) => q.key)).toEqual(['support']);
    const sales = (
      await as(boss).inject({
        method: 'POST',
        url: '/api/admin/queues',
        headers: hdr,
        payload: { key: 'Sales', name: 'Sales' },
      })
    ).json();
    expect(sales.key).toBe('sales');
    const put = await as(boss).inject({
      method: 'PUT',
      url: `/api/admin/queues/${sales.id}/members`,
      headers: hdr,
      payload: { userIds: [boss.id] },
    });
    expect(put.statusCode).toBe(200);
    queues = (await as(boss).inject({ url: '/api/admin/queues', headers: hdr })).json();
    expect(queues.find((q: { key: string }) => q.key === 'sales').memberIds).toEqual([boss.id]);
    const missing = await as(boss).inject({
      method: 'PUT',
      url: '/api/admin/queues/nope/members',
      headers: hdr,
      payload: { userIds: [] },
    });
    expect(missing.statusCode).toBe(404);
    // queue routing configuration: stored, defaulted, 404 on foreign queues
    const cfgPut = await as(boss).inject({
      method: 'PUT',
      url: `/api/admin/queues/${sales.id}/config`,
      headers: hdr,
      payload: {
        algorithm: 'most_skilled',
        requiredSkills: [{ skill: 'billing', min: 2 }],
        languageRouting: true,
      },
    });
    expect(cfgPut.statusCode).toBe(200);
    queues = (await as(boss).inject({ url: '/api/admin/queues', headers: hdr })).json();
    expect(queues.find((q: { key: string }) => q.key === 'sales').config).toMatchObject({
      algorithm: 'most_skilled',
      requiredSkills: [{ skill: 'billing', min: 2 }],
      languageRouting: true,
    });
    expect(
      (
        await as(boss).inject({
          method: 'PUT',
          url: '/api/admin/queues/nope/config',
          headers: hdr,
          payload: { algorithm: 'linear' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(boss).inject({
          method: 'PUT',
          url: `/api/admin/queues/${sales.id}/config`,
          headers: hdr,
          payload: { algorithm: 'psychic' },
        })
      ).statusCode,
    ).toBe(400);

    // member skills: replace, read back, clear
    const skillsPut = await as(boss).inject({
      method: 'PUT',
      url: `/api/admin/members/${boss.id}/skills`,
      headers: hdr,
      payload: {
        skills: [
          { skill: 'billing', proficiency: 4 },
          { skill: 'lang:de', proficiency: 2 },
        ],
      },
    });
    expect(skillsPut.statusCode).toBe(200);
    const held = (
      await as(boss).inject({ url: `/api/admin/members/${boss.id}/skills`, headers: hdr })
    ).json();
    expect(held).toEqual(
      expect.arrayContaining([
        { skill: 'billing', proficiency: 4 },
        { skill: 'lang:de', proficiency: 2 },
      ]),
    );
    expect(
      (
        await as(boss).inject({
          method: 'PUT',
          url: `/api/admin/members/${boss.id}/skills`,
          headers: hdr,
          payload: { skills: [{ skill: 'billing', proficiency: 9 }] },
        })
      ).statusCode,
    ).toBe(400);
    await as(boss).inject({
      method: 'PUT',
      url: `/api/admin/members/${boss.id}/skills`,
      headers: hdr,
      payload: { skills: [] },
    });
    expect(
      (await as(boss).inject({ url: `/api/admin/members/${boss.id}/skills`, headers: hdr })).json(),
    ).toEqual([]);

    // deleting: a queue with call history is archived (hidden, history intact), an unused
    // one is removed, the last one is refused, and an archived key can be reused
    await createCall(db, {
      id: 'c-archive',
      tenantId: t.id,
      queueId: sales.id,
      roomName: 'r',
      customerMeta: {},
    });
    const archived = await as(boss).inject({
      method: 'DELETE',
      url: `/api/admin/queues/${sales.id}`,
      headers: hdr,
    });
    expect(archived.json()).toEqual({ ok: true, archived: true });
    queues = (await as(boss).inject({ url: '/api/admin/queues', headers: hdr })).json();
    expect(queues.map((q: { key: string }) => q.key)).toEqual(['support']);
    expect((await getCall(db, 'c-archive'))?.queueId).toBe(sales.id);
    expect(
      (
        await as(boss).inject({
          method: 'DELETE',
          url: `/api/admin/queues/${sales.id}`,
          headers: hdr,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(boss).inject({
          method: 'DELETE',
          url: `/api/admin/queues/${queues[0].id}`,
          headers: hdr,
        })
      ).json(),
    ).toEqual({ error: 'last_queue' });
    const sales2 = (
      await as(boss).inject({
        method: 'POST',
        url: '/api/admin/queues',
        headers: hdr,
        payload: { key: 'sales', name: 'Sales again' },
      })
    ).json();
    expect(sales2.key).toBe('sales');
    expect(
      (
        await as(boss).inject({
          method: 'DELETE',
          url: `/api/admin/queues/${sales2.id}`,
          headers: hdr,
        })
      ).json(),
    ).toEqual({ ok: true, archived: false });

    const members = (await as(boss).inject({ url: '/api/admin/members', headers: hdr })).json();
    expect(members).toHaveLength(1);
    const invites = (await as(boss).inject({ url: '/api/admin/invites', headers: hdr })).json();
    expect(invites).toEqual([]);

    const key = (
      await as(boss).inject({
        method: 'POST',
        url: '/api/admin/embed-keys',
        headers: hdr,
        payload: { label: 'site', allowedOrigins: ['https://example.com'] },
      })
    ).json();
    expect(key.publicKey.startsWith('pk_')).toBe(true);
    expect(
      (await as(boss).inject({ url: '/api/admin/embed-keys', headers: hdr })).json(),
    ).toHaveLength(1);
    expect((await resolveEmbedKey(db, key.publicKey, 'support'))?.tenant.id).toBe(t.id);
    // the archived `sales` queue is not reachable from the embed either
    expect(await resolveEmbedKey(db, key.publicKey, 'sales')).toBeUndefined();
    expect(await resolveEmbedKey(db, key.publicKey, 'nope')).toBeUndefined();
    expect(await resolveEmbedKey(db, 'pk_nope', 'support')).toBeUndefined();
    const del = await as(boss).inject({
      method: 'DELETE',
      url: `/api/admin/embed-keys/${key.id}`,
      headers: hdr,
    });
    expect(del.statusCode).toBe(200);
    const del404 = await as(boss).inject({
      method: 'DELETE',
      url: `/api/admin/embed-keys/${key.id}`,
      headers: hdr,
    });
    expect(del404.statusCode).toBe(404);
  });
});
