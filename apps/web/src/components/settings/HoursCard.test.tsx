// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoursCard, parseWindows } from './HoursCard.tsx';
import { mocks, renderCard, resetMocks, select, toastText } from './testing.tsx';

vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks);

describe('HoursCard', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('parses window lines and drops malformed ones', () => {
    expect(parseWindows('mon 09:00-17:00\nbogus\nxyz 08:00-09:00\nTuesday 08:30 - 12:00')).toEqual([
      { dow: 1, from: '09:00', to: '17:00' },
      { dow: 2, from: '08:30', to: '12:00' },
    ]);
  });

  it('edits and saves the business hours with a toast', async () => {
    renderCard(<HoursCard />);
    await screen.findByText('Business hours');
    await select('Mode', 'Follow the schedule');
    const tz = screen.getByLabelText('Timezone (IANA)');
    await userEvent.clear(tz);
    await userEvent.type(tz, 'Europe/Zurich');
    await userEvent.type(screen.getByLabelText(/Weekly windows/), 'mon 09:00-17:00{Enter}bogus');
    await userEvent.type(screen.getByLabelText(/Holidays/), '2026-12-25{Enter}nope');
    const closedMsg = screen.getByLabelText('Closed message');
    await userEvent.clear(closedMsg);
    await userEvent.type(closedMsg, 'Closed.');
    const emergencyMsg = screen.getByLabelText('Emergency message');
    await userEvent.clear(emergencyMsg);
    await userEvent.type(emergencyMsg, 'Emergency.');
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/admin/tenant/settings', {
        hours: {
          mode: 'auto',
          timezone: 'Europe/Zurich',
          open: [{ dow: 1, from: '09:00', to: '17:00' }],
          holidays: ['2026-12-25'],
          closedMessage: 'Closed.',
          emergencyMessage: 'Emergency.',
        },
      }),
    );
    expect(toastText()).toContain('saved');
    mocks.patch.mockRejectedValueOnce(new Error('invalid_body'));
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() => expect(toastText()).toContain('The request was not valid'));
  }, 40_000);
});
