// @vitest-environment jsdom
import { useQueryClient } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import de from './locales/de/translation.json';

// The real App needs a session; a probe that reports the query client is enough to prove
// the provider tree is wired.
vi.mock('./App.tsx', () => ({
  App: () => {
    const qc = useQueryClient();
    return <div>app retry={String(qc.getDefaultOptions().queries?.retry)}</div>;
  },
}));

describe('main', () => {
  it('mounts the app with its providers into #root', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await act(async () => {
      await import('./main.tsx');
    });
    expect(screen.getByText('app retry=1')).toBeTruthy();
    expect(root.contains(screen.getByText('app retry=1'))).toBe(true);
    expect(document.documentElement.lang).toBe('en');
  });

  it('speaks the language of the cc_lng cookie and syncs <html lang>', async () => {
    document.cookie = 'cc_lng=de; path=/';
    const { Providers } = await import('./main.tsx');
    const Probe = () => {
      const { t } = useTranslation();
      return <p>{t('states.ready')}</p>;
    };
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(screen.getByText(de.states.ready)).toBeTruthy();
    expect(document.documentElement.lang).toBe('de');
    document.cookie = 'cc_lng=; path=/; max-age=0';
  });
});
