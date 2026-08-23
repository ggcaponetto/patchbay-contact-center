/**
 * Media assets: sound files (hold music, ringtone, ringback) a tenant uploads instead of
 * hosting them elsewhere. The bytes are stored in Postgres (`media_asset.data`, bytea)
 * and served by the public route `GET /api/public/media/:id`; the path of that route is
 * what settings store as a `SoundUrl`.
 *
 * Limits live here so the route and the UI agree: {@link MAX_ASSET_BYTES} per file and
 * the {@link ALLOWED_MIME} types. WAV uploads are sniffed ({@link isWav}) because the
 * media worker decodes WAV itself and a mislabeled MP3 would silently fall back to the
 * synthesized loop.
 *
 * @see apps/api/src/services/README.md
 * @packageDocumentation
 */
import type { MediaAsset } from '@cc/shared';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { mediaAsset } from '../db/schema.ts';

/** Largest accepted upload (decoded bytes): 5 MiB, about 30 s of 48 kHz stereo WAV. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/** Accepted `mimeType` values (browsers disagree on the WAV and MP3 names). */
export const ALLOWED_MIME: readonly string[] = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/webm',
  'audio/aac',
  'audio/mp4',
  'audio/flac',
];

/** True when `buf` starts with a RIFF/WAVE header (`RIFF....WAVE`). */
export const isWav = (buf: Uint8Array): boolean =>
  buf.length >= 12 &&
  String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' &&
  String.fromCharCode(...buf.subarray(8, 12)) === 'WAVE';

/** Public path an asset is served at; the value stored in `TenantSettings.sounds`. */
export const mediaUrl = (id: string): string => `/api/public/media/${id}`;

/** Columns safe to list: never `data`. */
const publicColumns = {
  id: mediaAsset.id,
  name: mediaAsset.name,
  mimeType: mediaAsset.mimeType,
  sizeBytes: mediaAsset.sizeBytes,
  createdAt: mediaAsset.createdAt,
};

const toDto = (row: {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}): MediaAsset => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  createdAt: row.createdAt.toISOString(),
  url: mediaUrl(row.id),
});

/** Stores a file for the tenant; size and type checks are the route's job. */
export async function createMediaAsset(
  db: Db,
  tenantId: string,
  input: { name: string; mimeType: string; data: Buffer },
): Promise<MediaAsset> {
  const [row] = await db
    .insert(mediaAsset)
    .values({
      id: randomUUID(),
      tenantId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
      data: input.data,
    })
    .returning(publicColumns);
  return toDto(row!);
}

/** The tenant's files, newest first, without their bytes. */
export async function listMediaAssets(db: Db, tenantId: string): Promise<MediaAsset[]> {
  const rows = await db
    .select(publicColumns)
    .from(mediaAsset)
    .where(eq(mediaAsset.tenantId, tenantId))
    .orderBy(desc(mediaAsset.createdAt));
  return rows.map(toDto);
}

/** Deletes a file of the tenant. @returns `false` when there is no such file. */
export async function deleteMediaAsset(db: Db, tenantId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(mediaAsset)
    .where(and(eq(mediaAsset.id, id), eq(mediaAsset.tenantId, tenantId)))
    .returning({ id: mediaAsset.id });
  return rows.length > 0;
}

/**
 * The bytes of a file for the public route. Not tenant-scoped: ids are random UUIDs and
 * sounds are not sensitive (they are played to anonymous callers anyway).
 */
export async function readMediaAsset(db: Db, id: string) {
  const [row] = await db
    .select({
      mimeType: mediaAsset.mimeType,
      sizeBytes: mediaAsset.sizeBytes,
      data: mediaAsset.data,
    })
    .from(mediaAsset)
    .where(eq(mediaAsset.id, id));
  return row;
}
