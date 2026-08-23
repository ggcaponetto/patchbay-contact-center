/**
 * Configurable sounds end to end over HTTP: uploading, listing, streaming and deleting
 * media assets, the validation limits, tenant isolation, and where the configured sounds
 * surface (`POST /api/public/calls` → `sounds.ringback`, `GET /api/desk/settings` →
 * `ringtone`, the hold command → `music`). Needs Postgres; skipped otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { MAX_ASSET_BYTES } from '../services/mediaAssets.ts';
import { createEmbedKey, createTenant, updateSettings } from '../services/tenants.ts';
import { createUser, dbAvailable, freshDb, resetDb, testServer } from '../testing.ts';

const hasDb = await dbAvailable();

/**
 * A minimal 16-bit mono PCM WAV (deliberately duplicated from the media worker's
 * `encodeWav`: the API must not import `apps/media`).
 */
const wavFile = (samples: number, sampleRate = 8000): Buffer => {
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return buf;
};

describe.skipIf(!hasDb)('media assets and configurable sounds', () => {
  let db: Db;
  let close: () => Promise<void>;
  let srv: Awaited<ReturnType<typeof testServer>>;
  let boss: Awaited<ReturnType<typeof createUser>>;
  let other: Awaited<ReturnType<typeof createUser>>;
  let tenantId: string;
  let publicKey: string;

  beforeAll(async () => {
    ({ db, close } = await freshDb());
    srv = await testServer(db);
  });
  afterAll(async () => {
    await srv.app.close();
    await close();
  });
  beforeEach(async () => {
    await resetDb(db);
    boss = await createUser(db, 'boss@example.com', 'Boss');
    other = await createUser(db, 'other@example.com', 'Other');
    tenantId = (await createTenant(db, 'Acme', boss.id)).id;
    await createTenant(db, 'Rival', other.id);
    publicKey = (await createEmbedKey(db, tenantId, 'site', [])).publicKey;
  });

  const upload = (
    payload: { name?: string; mimeType: string; data: Buffer | string },
    user = boss,
  ) =>
    srv.as(user).inject({
      method: 'POST',
      url: '/api/admin/media-assets',
      payload: {
        name: 'hold.wav',
        ...payload,
        data: Buffer.isBuffer(payload.data) ? payload.data.toString('base64') : payload.data,
      },
    });

  it('uploads a WAV, lists it without bytes, streams it publicly and deletes it', async () => {
    const file = wavFile(800);
    const res = await upload({ mimeType: 'audio/wav', data: file });
    expect(res.statusCode).toBe(200);
    const asset = res.json();
    expect(asset).toMatchObject({
      name: 'hold.wav',
      mimeType: 'audio/wav',
      sizeBytes: file.length,
      url: `/api/public/media/${asset.id}`,
    });
    expect(asset).not.toHaveProperty('data');
    expect(typeof asset.createdAt).toBe('string');

    const list = await srv.as(boss).inject({ url: '/api/admin/media-assets' });
    expect(list.json()).toEqual([asset]);

    // anyone can fetch the bytes, and they are cacheable forever
    const stream = await srv.as(null).inject({ url: asset.url });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toBe('audio/wav');
    expect(stream.headers['content-length']).toBe(String(file.length));
    expect(stream.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Buffer.compare(stream.rawPayload, file)).toBe(0);

    const del = await srv.as(boss).inject({
      method: 'DELETE',
      url: `/api/admin/media-assets/${asset.id}`,
    });
    expect(del.json()).toEqual({ ok: true });
    expect((await srv.as(null).inject({ url: asset.url })).statusCode).toBe(404);
    expect((await srv.as(null).inject({ url: asset.url })).json()).toEqual({ error: 'not_found' });
    expect(
      (await srv.as(boss).inject({ method: 'DELETE', url: `/api/admin/media-assets/${asset.id}` }))
        .statusCode,
    ).toBe(404);
    expect((await srv.as(boss).inject({ url: '/api/admin/media-assets' })).json()).toEqual([]);
  });

  it('rejects oversized files, non-audio types and mislabeled WAVs', async () => {
    const big = await upload({ mimeType: 'audio/mpeg', data: Buffer.alloc(MAX_ASSET_BYTES + 1) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'too_large', maxBytes: MAX_ASSET_BYTES });

    // the zod regex refuses non-audio outright, the allow-list refuses unknown audio types
    expect((await upload({ mimeType: 'image/png', data: wavFile(10) })).statusCode).toBe(400);
    const midi = await upload({ mimeType: 'audio/midi', data: wavFile(10) });
    expect(midi.statusCode).toBe(400);
    expect(midi.json()).toMatchObject({ error: 'unsupported_type' });

    const mp3Bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]);
    const fake = await upload({ mimeType: 'audio/x-wav', data: mp3Bytes });
    expect(fake.statusCode).toBe(400);
    expect(fake.json()).toEqual({ error: 'not_wav' });
    // the same bytes declared as MP3 are fine (only WAV is sniffed)
    expect((await upload({ mimeType: 'audio/MPEG', data: mp3Bytes })).json()).toMatchObject({
      mimeType: 'audio/mpeg',
    });
    expect((await upload({ mimeType: 'audio/wav', data: '' })).statusCode).toBe(400);
  });

  it('isolates assets per tenant and gates writes on tenant:write', async () => {
    const mine = (await upload({ mimeType: 'audio/wav', data: wavFile(10) })).json();
    const theirs = (await upload({ mimeType: 'audio/wav', data: wavFile(20) }, other)).json();
    expect((await srv.as(other).inject({ url: '/api/admin/media-assets' })).json()).toEqual([
      theirs,
    ]);
    const crossDelete = await srv.as(other).inject({
      method: 'DELETE',
      url: `/api/admin/media-assets/${mine.id}`,
    });
    expect(crossDelete.statusCode).toBe(404);
    expect((await srv.as(boss).inject({ url: '/api/admin/media-assets' })).json()).toEqual([mine]);
    // an agent (no tenant:write) cannot upload
    const agent = await createUser(db, 'agent@example.com');
    const { createInvite, bootstrapUser } = await import('../services/tenants.ts');
    await createInvite(db, tenantId, 'agent@example.com', 'agent');
    await bootstrapUser(db, agent, []);
    expect((await upload({ mimeType: 'audio/wav', data: wavFile(10) }, agent)).statusCode).toBe(
      403,
    );
    expect((await srv.as(null).inject({ url: '/api/admin/media-assets' })).statusCode).toBe(401);
  });

  it('surfaces the configured sounds to the embed, the desk and the media worker', async () => {
    const start = () =>
      srv.app.inject({
        method: 'POST',
        url: '/api/public/calls',
        payload: { embedKey: publicKey },
      });
    // nothing configured: empty `sounds`, no ringtone at the desk, no `music` on hold
    expect((await start()).json().sounds).toEqual({});
    expect((await srv.as(boss).inject({ url: '/api/desk/settings' })).json()).not.toHaveProperty(
      'ringtone',
    );

    const asset = (await upload({ mimeType: 'audio/wav', data: wavFile(10) })).json();
    const patch = await srv.as(boss).inject({
      method: 'PATCH',
      url: '/api/admin/tenant/settings',
      payload: {
        sounds: {
          holdMusic: asset.url,
          ringtone: 'https://cdn.example.com/ring.mp3',
          ringback: asset.url,
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect((await start()).json().sounds).toEqual({ ringback: asset.url });
    expect((await srv.as(boss).inject({ url: '/api/desk/settings' })).json()).toMatchObject({
      ringtone: 'https://cdn.example.com/ring.mp3',
    });

    const media: unknown[] = [];
    srv.bus.subscribe((m) => m.kind === 'media' && media.push(m.command));
    const { callId } = (await start()).json();
    await srv.flow.hold(callId);
    await new Promise((r) => setTimeout(r, 0));
    expect(media[0]).toMatchObject({ action: 'moh.start', callId, music: asset.url });

    // a queue-level file overrides the tenant's
    const [queue] = (await srv.as(boss).inject({ url: '/api/admin/queues' })).json();
    await srv.as(boss).inject({
      method: 'PUT',
      url: `/api/admin/queues/${queue.id}/config`,
      payload: { moh: 'bright', holdMusicUrl: 'https://cdn.example.com/queue.wav' },
    });
    const second = (await start()).json();
    await srv.flow.hold(second.callId);
    await new Promise((r) => setTimeout(r, 0));
    expect(media[1]).toMatchObject({ music: 'https://cdn.example.com/queue.wav', style: 'bright' });

    // invalid sound URLs are refused by the settings schema
    expect(
      await updateSettings(db, tenantId, { sounds: { ringtone: 'ftp://x' } as never }).catch(
        (e: Error) => e.name,
      ),
    ).toBe('ZodError');
  });
});
