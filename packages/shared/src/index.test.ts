import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  DispatchMetadata,
  ServerMessage,
  TenantSettings,
  defaultTenantSettings,
  roomNameFor,
} from './index.ts';

describe('TenantSettings', () => {
  it('fills every default from an empty object', () => {
    expect(defaultTenantSettings()).toEqual({
      routingMode: 'ai-first',
      handoff: { aiBehavior: 'leave' },
      humanFirstTimeoutSec: 30,
      offerTimeoutSec: 20,
      aiAgent: { instructions: '', greeting: 'Greet the caller and ask how you can help.' },
    });
  });

  it('keeps explicit values and rejects invalid ones', () => {
    const parsed = TenantSettings.parse({
      routingMode: 'human-first',
      handoff: { aiBehavior: 'listen' },
      humanFirstTimeoutSec: 45,
    });
    expect(parsed.routingMode).toBe('human-first');
    expect(parsed.handoff.aiBehavior).toBe('listen');
    expect(parsed.humanFirstTimeoutSec).toBe(45);
    expect(() => TenantSettings.parse({ routingMode: 'robot-first' })).toThrow();
    expect(() => TenantSettings.parse({ humanFirstTimeoutSec: 1 })).toThrow();
  });
});

describe('DispatchMetadata', () => {
  it('round-trips through JSON with defaults applied', () => {
    const meta = DispatchMetadata.parse(
      JSON.parse(
        JSON.stringify({
          callId: 'c1',
          tenantId: 't1',
          queueKey: 'support',
          settings: {},
        }),
      ),
    );
    expect(meta.customerMeta).toEqual({});
    expect(meta.settings.routingMode).toBe('ai-first');
  });
});

describe('websocket messages', () => {
  it('accepts known message types and rejects unknown ones', () => {
    expect(ClientMessage.parse({ type: 'status', status: 'available' }).type).toBe('status');
    expect(ServerMessage.parse({ type: 'call.updated', callId: 'c1', status: 'human' }).type).toBe(
      'call.updated',
    );
    expect(() => ClientMessage.parse({ type: 'nope' })).toThrow();
    expect(() => ServerMessage.parse({ type: 'presence', agents: [{ userId: 'u' }] })).toThrow();
  });
});

describe('roomNameFor', () => {
  it('prefixes tenant and call ids', () => {
    expect(roomNameFor('t1', 'c1')).toBe('cc-t1-c1');
  });
});
