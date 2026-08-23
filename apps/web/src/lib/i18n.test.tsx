// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, test } from 'vitest';
import de from '../locales/de/translation.json';
import it from '../locales/it/translation.json';
import { MUI_LOCALES, createWebI18n, useLocaleFormat } from './i18n.ts';

function Stamp({ iso }: { iso: string }) {
  const f = useLocaleFormat();
  return (
    <div>
      <span data-testid="dt">{f.dateTime(iso)}</span>
      <span data-testid="t">{f.time(iso)}</span>
    </div>
  );
}

describe('web i18n', () => {
  afterEach(cleanup);

  test('creates an instance with both namespaces in every language', () => {
    const german = createWebI18n('de');
    expect(german.language).toBe('de');
    expect(german.t('states.ready')).toBe(de.states.ready);
    expect(german.t('callPanel.onHoldFor', { count: 1 })).toBe(
      de.callPanel.onHoldFor_one.replace('{{count}}', '1'),
    );
    expect(german.t('callPanel.onHoldFor', { count: 5 })).toBe(
      de.callPanel.onHoldFor_other.replace('{{count}}', '5'),
    );
    expect(german.hasResourceBundle('de', 'settings')).toBe(true);
    expect(createWebI18n('it').t('states.ready')).toBe(it.states.ready);
    expect(createWebI18n('en').t('states.ready')).toBe('Ready');
    expect(Object.keys(MUI_LOCALES).sort()).toEqual(['de', 'en', 'it']);
  });

  test('formats dates and times for the current language', () => {
    const iso = '2026-08-23T12:05:09.000Z';
    const en = new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'medium' });
    const { rerender } = render(
      <I18nextProvider i18n={createWebI18n('en')}>
        <Stamp iso={iso} />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('dt').textContent).toBe(en.format(new Date(iso)));
    expect(screen.getByTestId('t').textContent).toBe(
      new Intl.DateTimeFormat('en', { timeStyle: 'medium' }).format(new Date(iso)),
    );
    rerender(
      <I18nextProvider i18n={createWebI18n('de')}>
        <Stamp iso={iso} />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('dt').textContent).toBe(
      new Intl.DateTimeFormat('de', { dateStyle: 'short', timeStyle: 'medium' }).format(
        new Date(iso),
      ),
    );
  });
});
