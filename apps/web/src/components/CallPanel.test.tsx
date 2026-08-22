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
vi.mock('../lib/hooks.ts', () => ({ useLiveRoom: () => live.room }));

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

  it('leaves automatically once connected without a customer', () => {
    live.room.connected = true;
    live.room.peers = [{ identity: 'ai:1', name: '', role: 'ai' }];
    const onLeave = vi.fn();
    render(<CallPanel join={join} title="Customer call" transcript={[]} onLeave={onLeave} />);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe('Transcript', () => {
  afterEach(cleanup);

  it('renders text and speaker per segment', () => {
    render(
      <Transcript
        segments={[
          { speaker: 'customer', identity: 'customer:1', text: 'Hi' },
          { speaker: 'human', identity: 'human:u', text: 'Hello' },
        ]}
      />,
    );
    expect(screen.getByText('Hi')).toBeTruthy();
    expect(screen.getByText('human')).toBeTruthy();
    expect(screen.queryByText('No transcript yet.')).toBeNull();
  });
});
