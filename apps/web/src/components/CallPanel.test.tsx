// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomState } from '../lib/hooks.ts';
import { CallPanel, Transcript } from './CallPanel.tsx';

/** Controllable `useLiveRoom` double; `room` is what the next render returns. */
const live = vi.hoisted(() => ({
  room: {} as RoomState & { audioRef: { current: null }; toggleMute: () => Promise<void> },
}));
vi.mock('../lib/hooks.ts', () => ({ useLiveRoom: () => live.room, useNow: () => Date.now() }));

const join = { token: 't', url: 'u', publish: true };
const customer = { identity: 'customer:1', name: '', role: 'customer' };

describe('CallPanel', () => {
  beforeEach(() => {
    live.room = {
      room: null,
      connected: false,
      muted: false,
      peers: [],
      audioRef: { current: null },
      toggleMute: vi.fn(() => Promise.resolve()),
      setHeld: vi.fn(() => Promise.resolve()),
    };
  });
  afterEach(cleanup);

  it('shows the connecting chip and no mute button while listening', () => {
    const onLeave = vi.fn();
    render(
      <CallPanel
        join={{ ...join, publish: false }}
        title="Listening in"
        transcript={[]}
        onLeave={onLeave}
      />,
    );
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(screen.queryByText('Mute')).toBeNull();
    expect(screen.getByText('No transcript yet.')).toBeTruthy();
    // Not connected yet: the missing customer does not end the call.
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('lists peers, toggles mute and hangs up', async () => {
    live.room.connected = true;
    live.room.peers = [customer, { identity: 'ai:1', name: 'Bot', role: 'ai' }];
    const onLeave = vi.fn();
    const transcript = [{ speaker: 'ai' as const, identity: 'ai:1', text: 'Hello' }];
    const { rerender } = render(
      <CallPanel join={join} title="Customer call" transcript={transcript} onLeave={onLeave} />,
    );
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('customer')).toBeTruthy();
    expect(screen.getByText('ai: Bot')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(onLeave).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(screen.getByText('Mute'));
    expect(live.room.toggleMute).toHaveBeenCalled();
    live.room = { ...live.room, muted: true };
    rerender(
      <CallPanel join={join} title="Customer call" transcript={transcript} onLeave={onLeave} />,
    );
    expect(screen.getByText('Unmute')).toBeTruthy();

    await user.click(screen.getByText('Hang up'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('shows hold with its timer and the too-long reminder', () => {
    live.room = { ...live.room, connected: true, peers: [customer] };
    const onToggle = vi.fn();
    const heldAt = new Date(Date.now() - 65_000).toISOString();
    render(
      <CallPanel
        join={join}
        title="T"
        transcript={[]}
        onLeave={vi.fn()}
        hold={{ heldAt, onToggle, reminderAfterSec: 60 }}
      />,
    );
    expect(screen.getByText(/Retrieve \(1:0\d\)/)).toBeTruthy();
    expect(screen.getByText(/on hold for \d+ seconds/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mute' }) as HTMLButtonElement).disabled).toBe(true);
    screen.getByText(/Retrieve/).click();
    expect(onToggle).toHaveBeenCalled();
    expect(live.room.setHeld).toHaveBeenCalledWith(true);

    cleanup();
    render(
      <CallPanel
        join={join}
        title="T"
        transcript={[]}
        onLeave={vi.fn()}
        hold={{ heldAt: null, onToggle, reminderAfterSec: 0 }}
      />,
    );
    expect(screen.getByText('Hold')).toBeTruthy();
    expect(screen.queryByText(/on hold for/)).toBeNull();
  });

  it('applies the hold state once per change and ignores an unknown state', () => {
    live.room = { ...live.room, connected: true, peers: [customer] };
    const onToggle = vi.fn();
    const heldAt = new Date().toISOString();
    const view = (value: string | null | undefined) => (
      <CallPanel
        join={join}
        title="T"
        transcript={[]}
        onLeave={vi.fn()}
        hold={{ heldAt: value, onToggle, reminderAfterSec: 0 }}
      />
    );
    const { rerender } = render(view(heldAt));
    expect(live.room.setHeld).toHaveBeenCalledTimes(1);
    expect(live.room.setHeld).toHaveBeenLastCalledWith(true);
    // a re-render with the same state (refetch, timer tick) does not re-apply it
    rerender(view(heldAt));
    rerender(view(new Date(Date.now() - 1000).toISOString()));
    expect(live.room.setHeld).toHaveBeenCalledTimes(1);
    // unknown (detail not fetched yet) keeps what is applied
    rerender(view(undefined));
    expect(live.room.setHeld).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Hold')).toBeTruthy();
    rerender(view(heldAt));
    expect(live.room.setHeld).toHaveBeenCalledTimes(1);
    // a real retrieve is applied exactly once
    rerender(view(null));
    expect(live.room.setHeld).toHaveBeenCalledTimes(2);
    expect(live.room.setHeld).toHaveBeenLastCalledWith(false);
  });

  it('leaves only when a customer who was here left', () => {
    const onLeave = vi.fn();
    // connected but the room is still filling up: no leave
    live.room = { ...live.room, connected: true, peers: [] };
    const { rerender } = render(
      <CallPanel join={join} title="T" transcript={[]} onLeave={onLeave} />,
    );
    expect(onLeave).not.toHaveBeenCalled();
    // the customer arrives, then hangs up: leave
    live.room = { ...live.room, connected: true, peers: [customer] };
    rerender(<CallPanel join={join} title="T" transcript={[]} onLeave={onLeave} />);
    expect(onLeave).not.toHaveBeenCalled();
    live.room = { ...live.room, connected: true, peers: [] };
    rerender(<CallPanel join={join} title="T" transcript={[]} onLeave={onLeave} />);
    expect(onLeave).toHaveBeenCalled();
  });
});

describe('Transcript', () => {
  afterEach(cleanup);

  it('renders text and speaker per segment, raw or through labelFor', () => {
    const segments = [
      { speaker: 'customer' as const, identity: 'customer:1', text: 'Hi' },
      { speaker: 'human' as const, identity: 'human:u', text: 'Hello' },
    ];
    const { rerender } = render(<Transcript segments={segments} />);
    expect(screen.getByText('Hi')).toBeTruthy();
    expect(screen.getByText('human')).toBeTruthy();
    expect(screen.queryByText('No transcript yet.')).toBeNull();
    expect(screen.getByRole('list').getAttribute('aria-live')).toBe('polite');
    rerender(<Transcript segments={segments} labelFor={(s) => `<${s.identity}>`} />);
    expect(screen.getByText('<human:u>')).toBeTruthy();
    expect(screen.queryByText('human')).toBeNull();
  });
});
