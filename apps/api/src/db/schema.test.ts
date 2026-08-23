import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.ts';

const tables = {
  user: schema.user,
  session: schema.session,
  account: schema.account,
  verification: schema.verification,
  tenant: schema.tenant,
  membership: schema.membership,
  invite: schema.invite,
  queue: schema.queue,
  queueMember: schema.queueMember,
  embedKey: schema.embedKey,
  call: schema.call,
  callParticipant: schema.callParticipant,
  transcriptSegment: schema.transcriptSegment,
  callEvent: schema.callEvent,
};

/** Resolves the lazy `references(() => ...)` callbacks and returns `child->parent` pairs. */
const foreignKeys = (table: keyof typeof tables) =>
  getTableConfig(tables[table])
    .foreignKeys.map((fk) => fk.reference())
    .map(
      (r) =>
        `${r.columns[0]!.name}->${getTableConfig(r.foreignTable).name}.${r.foreignColumns[0]!.name}`,
    );

const indexNames = (table: keyof typeof tables) =>
  getTableConfig(tables[table]).indexes.map((i) => i.config.name);

describe('schema', () => {
  it('stamps updated_at on update for the Better Auth tables', () => {
    for (const t of [schema.user, schema.session, schema.account, schema.verification]) {
      const fn = t.updatedAt.onUpdateFn;
      expect(fn).toBeTypeOf('function');
      expect(fn!()).toBeInstanceOf(Date);
    }
    expect(schema.tenant.createdAt.onUpdateFn).toBeUndefined();
  });

  it('wires the Better Auth tables to user', () => {
    expect(foreignKeys('session')).toEqual(['user_id->user.id']);
    expect(foreignKeys('account')).toEqual(['user_id->user.id']);
    expect(foreignKeys('verification')).toEqual([]);
    expect(indexNames('session')).toEqual(['session_user_id_idx']);
    expect(indexNames('account')).toEqual(['account_user_id_idx']);
    expect(indexNames('verification')).toEqual(['verification_identifier_idx']);
  });

  it('hangs the tenant tables off tenant and user', () => {
    expect(foreignKeys('membership')).toEqual(['user_id->user.id', 'tenant_id->tenant.id']);
    expect(foreignKeys('invite')).toEqual(['tenant_id->tenant.id']);
    expect(foreignKeys('queue')).toEqual(['tenant_id->tenant.id']);
    expect(foreignKeys('queueMember')).toEqual(['queue_id->queue.id', 'user_id->user.id']);
    expect(foreignKeys('embedKey')).toEqual(['tenant_id->tenant.id']);
    expect(getTableConfig(schema.queueMember).primaryKeys[0]!.columns.map((c) => c.name)).toEqual([
      'queue_id',
      'user_id',
    ]);
    for (const [t, name] of [
      ['membership', 'membership_user_tenant_uidx'],
      ['invite', 'invite_tenant_email_uidx'],
      ['queue', 'queue_tenant_key_uidx'],
    ] as const) {
      const [idx] = getTableConfig(tables[t]).indexes;
      expect(idx!.config).toMatchObject({ name, unique: true });
    }
  });

  it('cascades call children but never drops a queue with history', () => {
    expect(foreignKeys('call')).toEqual([
      'tenant_id->tenant.id',
      'queue_id->queue.id',
      'preferred_agent_id->user.id',
    ]);
    // a deleted preferred agent must not take the call's history with it
    expect(getTableConfig(schema.call).foreignKeys.map((fk) => fk.onDelete)).toEqual([
      'cascade',
      'no action',
      'set null',
    ]);
    expect(foreignKeys('callParticipant')).toEqual(['call_id->call.id', 'user_id->user.id']);
    expect(foreignKeys('transcriptSegment')).toEqual(['call_id->call.id']);
    expect(foreignKeys('callEvent')).toEqual(['call_id->call.id']);
    expect(indexNames('call')).toEqual(['call_tenant_started_idx']);
    expect(indexNames('transcriptSegment')).toEqual(['transcript_call_idx']);
    expect(indexNames('callEvent')).toEqual(['call_event_call_idx']);
  });
});
