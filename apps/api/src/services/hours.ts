/**
 * Business-hours evaluation: is the tenant taking calls right now? Pure function over
 * `TenantSettings.hours`, evaluated in the tenant's timezone at contact creation
 * (`POST /api/public/calls` refuses with the configured message while closed).
 *
 * @see apps/api/src/services/README.md
 * @packageDocumentation
 */
import type { TenantSettings } from '@cc/shared';

/** Result of {@link openState}: taking calls, or closed with the message to show. */
export type OpenState = { open: true } | { open: false; message: string };

/** Local date parts of `now` in `timezone` (falls back to UTC on a bad zone). */
const localParts = (timezone: string, now: number) => {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return {
    dow,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
};

/** Parses `HH:MM` into minutes since midnight (`0` for malformed input). */
const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Evaluates the hours configuration at `now`.
 *
 * - `off`: always open (the default; hours are not used).
 * - `open` / `closed` / `emergency`: forced by a supervisor, schedule ignored.
 * - `auto`: closed on holidays, otherwise open while any weekly window
 *   (`dow`, `from`–`to` in the tenant's timezone) contains the current time.
 */
export function openState(hours: TenantSettings['hours'], now = Date.now()): OpenState {
  if (hours.mode === 'off' || hours.mode === 'open') return { open: true };
  if (hours.mode === 'emergency') return { open: false, message: hours.emergencyMessage };
  if (hours.mode === 'closed') return { open: false, message: hours.closedMessage };
  const local = localParts(hours.timezone, now);
  if (hours.holidays.includes(local.date)) return { open: false, message: hours.closedMessage };
  const inWindow = hours.open.some(
    (w) =>
      w.dow === local.dow && toMinutes(w.from) <= local.minutes && local.minutes < toMinutes(w.to),
  );
  return inWindow ? { open: true } : { open: false, message: hours.closedMessage };
}
