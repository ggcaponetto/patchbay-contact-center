// @vitest-environment jsdom
import { LANGUAGE_COOKIE } from '@cc/i18n';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebI18n } from '../lib/i18n.ts';
import de from '../locales/de/translation.json';
import { LanguageMenu } from './LanguageMenu.tsx';

function Probe() {
  const { t } = useTranslation();
  return <p>{t('states.ready')}</p>;
}

describe('LanguageMenu', () => {
  afterEach(() => {
    cleanup();
    document.cookie = `${LANGUAGE_COOKIE}=; path=/; max-age=0`;
  });

  it('lists the languages, switches the instance and persists the cookie', async () => {
    const i18n = createWebI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageMenu />
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByText('Ready')).toBeTruthy();
    await userEvent.click(screen.getByRole('combobox', { name: 'Language' }));
    const list = within(screen.getByRole('listbox'));
    expect(list.getByText('English')).toBeTruthy();
    expect(list.getByText('Italiano')).toBeTruthy();
    await userEvent.click(list.getByText('Deutsch'));
    expect(await screen.findByText(de.states.ready)).toBeTruthy();
    expect(i18n.language).toBe('de');
    expect(document.cookie).toContain('cc_lng=de');
    expect(screen.getByRole('combobox', { name: de.app.language })).toBeTruthy();
  });
});
