// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoundsCard } from './SoundsCard.tsx';
import { mocks, renderCard, resetMocks, toastText } from './testing.tsx';

vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks);

/** jsdom has no media playback: record play/pause calls instead. */
const media = vi.hoisted(() => ({ play: vi.fn(() => Promise.resolve()), pause: vi.fn() }));

describe('SoundsCard', () => {
  beforeEach(() => {
    resetMocks();
    media.play.mockClear();
    media.pause.mockClear();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(media.play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(media.pause);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('edits the three sounds by URL, upload and from the uploaded files, and saves', async () => {
    renderCard(<SoundsCard />);
    expect(await screen.findByText('jingle.wav')).toBeTruthy();
    expect(screen.getByText('3.0 MB')).toBeTruthy();
    // a WAV can be used for anything; an mp3 not as hold music
    const useButtons = screen.getAllByRole('button', { name: 'Use as hold music' });
    expect(useButtons[0]).toHaveProperty('disabled', false);
    expect(useButtons[1]).toHaveProperty('disabled', true);
    await userEvent.click(useButtons[0]!);
    expect(screen.getByLabelText('Hold music URL')).toHaveProperty('value', '/api/public/media/a1');
    await userEvent.type(screen.getByLabelText('Ringtone URL'), 'https://cdn.example/ring.mp3');
    // upload for ringback: the file goes to the API and its URL lands in the field
    mocks.uploadMediaAsset.mockResolvedValueOnce({
      id: 'a3',
      name: 'back.ogg',
      mimeType: 'audio/ogg',
      sizeBytes: 10,
      createdAt: 'x',
      url: '/api/public/media/a3',
    });
    const file = new File(['x'], 'back.ogg', { type: 'audio/ogg' });
    await userEvent.upload(screen.getByLabelText('Upload ringback'), file);
    await waitFor(() => expect(mocks.uploadMediaAsset).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(screen.getByLabelText('Ringback URL')).toHaveProperty('value', '/api/public/media/a3'),
    );
    expect(toastText()).toContain('back.ogg uploaded');
    // play / stop toggles one audio element
    const play = screen.getAllByRole('button', { name: 'Play' })[0]!;
    await userEvent.click(play);
    expect(media.play).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(media.pause).toHaveBeenCalled();
    // clear empties a field
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear' })[1]!);
    expect(screen.getByLabelText('Ringtone URL')).toHaveProperty('value', '');
    await userEvent.click(screen.getByRole('button', { name: 'Save sounds' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/admin/tenant/settings', {
        sounds: { holdMusic: '/api/public/media/a1', ringback: '/api/public/media/a3' },
      }),
    );
    expect(toastText()).toContain('Sounds saved');
  }, 40_000);

  it('deletes uploaded files after confirming and reports failures', async () => {
    renderCard(<SoundsCard />);
    expect(await screen.findByText('jingle.wav')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'delete file jingle.wav' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/admin/media-assets/a1'));
    await waitFor(() => expect(toastText()).toContain('File deleted'));
    mocks.uploadMediaAsset.mockRejectedValueOnce(new Error('too_large'));
    await userEvent.upload(
      screen.getByLabelText('Upload hold music'),
      new File(['x'], 'big.wav', { type: 'audio/wav' }),
    );
    await waitFor(() => expect(toastText()).toContain('The file is too large'));
    media.play.mockRejectedValueOnce(new Error('NotSupported'));
    await userEvent.type(screen.getByLabelText('Ringtone URL'), 'https://x/y.mp3');
    await userEvent.click(screen.getAllByRole('button', { name: 'Play' })[1]!);
    await waitFor(() => expect(toastText()).toContain('Cannot play'));
  }, 40_000);
});
