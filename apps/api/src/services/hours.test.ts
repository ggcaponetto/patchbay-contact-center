import { defaultTenantSettings } from '@cc/shared';
import { describe, expect, it } from 'vitest';
import { openState } from './hours.ts';

/** A Wednesday, 12:00 UTC (2026-08-19). */
const NOON = Date.parse('2026-08-19T12:00:00Z');

const hours = (patch: Partial<ReturnType<typeof defaultTenantSettings>['hours']>) => ({
  ...defaultTenantSettings().hours,
  ...patch,
});

describe('openState', () => {
  it('is always open in off mode and honours the forced modes', () => {
    expect(openState(hours({}), NOON)).toEqual({ open: true });
    expect(openState(hours({ mode: 'open' }), NOON)).toEqual({ open: true });
    const closed = openState(hours({ mode: 'closed', closedMessage: 'Bye' }), NOON);
    expect(closed).toEqual({ open: false, message: 'Bye' });
    const emergency = openState(hours({ mode: 'emergency', emergencyMessage: 'Flood' }), NOON);
    expect(emergency).toEqual({ open: false, message: 'Flood' });
  });

  it('follows the weekly windows in the configured timezone', () => {
    const auto = hours({
      mode: 'auto',
      timezone: 'UTC',
      open: [{ dow: 3, from: '09:00', to: '17:00' }], // Wednesdays
    });
    expect(openState(auto, NOON)).toEqual({ open: true });
    expect(openState(auto, Date.parse('2026-08-19T18:00:00Z')).open).toBe(false);
    expect(openState(auto, Date.parse('2026-08-20T12:00:00Z')).open).toBe(false); // Thursday
    // At noon UTC it is already evening in Tokyo: the same window is closed there.
    expect(openState({ ...auto, timezone: 'Asia/Tokyo' }, NOON).open).toBe(false);
    // An unknown timezone falls back to UTC instead of throwing.
    expect(openState({ ...auto, timezone: 'Nowhere/Invalid' }, NOON)).toEqual({ open: true });
  });

  it('treats holidays as closed and tolerates malformed times', () => {
    const auto = hours({
      mode: 'auto',
      open: [{ dow: 3, from: '09:00', to: '17:00' }],
      holidays: ['2026-08-19'],
      closedMessage: 'Holiday',
    });
    expect(openState(auto, NOON)).toEqual({ open: false, message: 'Holiday' });
    expect(
      openState(hours({ mode: 'auto', open: [{ dow: 3, from: 'xx', to: 'yy' }] }), NOON).open,
    ).toBe(false); // malformed bounds parse to 0..0, never open
  });
});
