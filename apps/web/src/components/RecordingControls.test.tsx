// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingControls } from './RecordingControls.tsx';

const post = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.ts', () => ({ post }));

describe('RecordingControls', () => {
  beforeEach(() => post.mockReset().mockResolvedValue({ ok: true }));
  afterEach(cleanup);

  it('shows the right controls per state and posts the actions', async () => {
    const { rerender } = render(<RecordingControls callId="c1" state="off" />);
    expect(screen.queryByText('REC')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(post).toHaveBeenCalledWith('/desk/calls/c1/recording', { action: 'start' });

    rerender(<RecordingControls callId="c1" state="on" />);
    expect(screen.getByText('REC')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Pause recording' }));
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/recording', { action: 'pause' });

    rerender(<RecordingControls callId="c1" state="paused" />);
    expect(screen.getByText('REC paused')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Resume recording' }));
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/recording', { action: 'resume' });
    await userEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/recording', { action: 'stop' });
  });

  it('reports failures through onError and swallows them without one', async () => {
    post.mockRejectedValueOnce(new Error('recording_unavailable'));
    const onError = vi.fn();
    const { rerender } = render(<RecordingControls callId="c1" state="off" onError={onError} />);
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(onError).toHaveBeenCalledWith('recording_unavailable');
    post.mockRejectedValueOnce('nope'); // a non-Error rejection, stringified
    rerender(<RecordingControls callId="c1" state="off" />);
    await userEvent.click(screen.getByRole('button', { name: 'Record' })); // no throw
  });
});
