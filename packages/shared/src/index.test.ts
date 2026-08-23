/**
 * Unit tests for the shared contracts: defaults of `TenantSettings`, JSON round-trip of
 * `DispatchMetadata`, accept/reject of websocket messages and the room-name helper.
 * Extend them whenever a schema gains a field or an enum value.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentStateRequest,
  ClientMessage,
  DispatchMetadata,
  MediaAsset,
  MediaCommand,
  QueueConfig,
  ServerMessage,
  SoundUrl,
  TenantSettings,
  baseLanguage,
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
      acwSec: 30,
      dispositions: [],
      dispositionRequired: false,
      holdReminderSec: 60,
      autoAnswer: false,
      monitorNotify: true,
      ticker: '',
      hours: {
        mode: 'off',
        timezone: 'UTC',
        open: [],
        holidays: [],
        closedMessage: 'We are currently closed. Please call again during business hours.',
        emergencyMessage: 'We are currently unable to take calls. Please try again later.',
      },
      alerts: { maxWaiting: 0, maxWaitSec: 0, maxCallSec: 0 },
      notReadyReasons: ['Break', 'Lunch', 'Meeting', 'Training'],
      aiAgent: { instructions: '', greeting: 'Greet the caller and ask how you can help.' },
      sounds: {},
      skills: [],
    });
  });

  it('validates the routing skill catalogue', () => {
    const t = TenantSettings.parse({ skills: [{ key: 'billing', label: 'Billing' }] });
    expect(t.skills).toEqual([{ key: 'billing', label: 'Billing', description: '' }]);
    expect(() => TenantSettings.parse({ skills: [{ key: 'Billing', label: 'x' }] })).toThrow();
    expect(() => TenantSettings.parse({ skills: [{ key: 'lang:de', label: 'x' }] })).toThrow();
    expect(() => TenantSettings.parse({ skills: [{ key: 'ok', label: '' }] })).toThrow();
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

describe('sounds', () => {
  it('accepts http(s) URLs and uploaded-media paths only', () => {
    expect(SoundUrl.parse('https://cdn.example.com/hold.mp3')).toBe(
      'https://cdn.example.com/hold.mp3',
    );
    expect(SoundUrl.parse('http://localhost:4000/x.wav')).toBe('http://localhost:4000/x.wav');
    expect(SoundUrl.parse('/api/public/media/abc')).toBe('/api/public/media/abc');
    for (const bad of [
      'ftp://x/y.wav',
      '/etc/passwd',
      'hold.mp3',
      `https://x/${'a'.repeat(500)}`,
    ]) {
      expect(SoundUrl.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('is optional everywhere: tenant settings, queue config, media command', () => {
    const t = TenantSettings.parse({ sounds: { ringtone: '/api/public/media/r1' } });
    expect(t.sounds).toEqual({ ringtone: '/api/public/media/r1' });
    expect(() => TenantSettings.parse({ sounds: { ringback: 'nope' } })).toThrow();
    expect(QueueConfig.parse({}).holdMusicUrl).toBeUndefined();
    expect(QueueConfig.parse({}).relaxAfterSec).toBe(20);
    expect(QueueConfig.parse({ relaxAfterSec: 0 }).relaxAfterSec).toBe(0);
    expect(() => QueueConfig.parse({ relaxAfterSec: 301 })).toThrow();
    expect(QueueConfig.parse({ holdMusicUrl: 'https://x/h.wav' }).holdMusicUrl).toBe(
      'https://x/h.wav',
    );
    const cmd = MediaCommand.parse({
      action: 'moh.start',
      callId: 'c',
      roomName: 'r',
      token: 't',
      url: 'wss://lk',
      music: '/api/public/media/m1',
    });
    expect(cmd).toMatchObject({ music: '/api/public/media/m1' });
    expect(
      MediaAsset.parse({
        id: 'm1',
        name: 'hold.wav',
        mimeType: 'audio/wav',
        sizeBytes: 44,
        createdAt: '2026-01-01T00:00:00.000Z',
        url: '/api/public/media/m1',
      }).url,
    ).toBe('/api/public/media/m1');
    expect(MediaAsset.safeParse({ id: 'm1' }).success).toBe(false);
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
    expect(meta.language).toBeUndefined();
    expect(DispatchMetadata.parse({ ...meta, language: 'de-CH' }).language).toBe('de-CH');
  });
});

describe('websocket messages', () => {
  it('accepts known message types and rejects unknown ones', () => {
    expect(ClientMessage.parse({ type: 'subscribe', callId: 'c1' }).type).toBe('subscribe');
    expect(AgentStateRequest.parse({ state: 'not_ready', reason: 'Break' }).reason).toBe('Break');
    expect(() => AgentStateRequest.parse({ state: 'busy' })).toThrow();
    expect(TenantSettings.parse({}).acwSec).toBe(30);
    expect(TenantSettings.parse({}).notReadyReasons).toContain('Lunch');
    expect(ServerMessage.parse({ type: 'call.updated', callId: 'c1', status: 'human' }).type).toBe(
      'call.updated',
    );
    expect(
      ServerMessage.parse({ type: 'call.updated', callId: 'c1', status: 'human', heldAt: null }),
    ).toMatchObject({ heldAt: null });
    expect(
      ServerMessage.parse({
        type: 'call.offer',
        callId: 'c1',
        queueKey: 'support',
        expiresAt: '2026-01-01T00:00:00.000Z',
        requiredSkills: ['billing'],
        language: 'de',
        relaxed: true,
      }),
    ).toMatchObject({ requiredSkills: ['billing'], language: 'de', relaxed: true });
    expect(() => ClientMessage.parse({ type: 'nope' })).toThrow();
    expect(() => ServerMessage.parse({ type: 'presence', agents: [{ userId: 'u' }] })).toThrow();
  });
});

describe('baseLanguage', () => {
  it('keeps the lowercase primary language', () => {
    expect(baseLanguage('de-CH')).toBe('de');
    expect(baseLanguage('EN_us')).toBe('en');
    expect(baseLanguage(' it ')).toBe('it');
    expect(baseLanguage('')).toBe('');
  });
});

describe('roomNameFor', () => {
  it('prefixes tenant and call ids', () => {
    expect(roomNameFor('t1', 'c1')).toBe('cc-t1-c1');
  });
});
