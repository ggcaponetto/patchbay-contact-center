/**
 * The desk's i18n wiring on top of `@cc/i18n`: the i18next instance with both
 * namespaces (`translation` for the desk, `settings` for the settings cards) in every
 * supported language, the matching MUI locale bundles, and a hook for locale-aware
 * date formatting. `main.tsx` creates the instance once from the detected language;
 * `tests/setup/i18n.ts` does the same in English for the unit tests.
 */
import { type Language, createI18n } from '@cc/i18n';
import { type Localization, deDE, enUS, itIT } from '@mui/material/locale';
import type { i18n } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import deSettings from '../locales/de/settings.json';
import de from '../locales/de/translation.json';
import enSettings from '../locales/en/settings.json';
import en from '../locales/en/translation.json';
import itSettings from '../locales/it/settings.json';
import it from '../locales/it/translation.json';

/** MUI component texts (pagination, select placeholders…) per language. */
export const MUI_LOCALES: Record<Language, Localization> = { en: enUS, de: deDE, it: itIT };

/**
 * The desk's i18next instance in `lng`, registered as react-i18next's default so
 * `useTranslation()` works without a provider (the unit tests rely on it). One copy of
 * `react-i18next` must be shared with `@cc/i18n` (hoisted in the workspace root).
 */
export function createWebI18n(lng: Language): i18n {
  const instance = createI18n({
    resources: {
      en: { translation: en, settings: enSettings },
      de: { translation: de, settings: deSettings },
      it: { translation: it, settings: itSettings },
    },
    lng,
    ns: ['translation', 'settings'],
    react: true,
  });
  return instance;
}

/** Formatters of {@link useLocaleFormat}. */
export type LocaleFormat = {
  /** Date and time of an ISO timestamp, e.g. `23.08.2026, 14:05:09` in German. */
  dateTime: (iso: string) => string;
  /** Time of day of an ISO timestamp, e.g. `14:05:09`. */
  time: (iso: string) => string;
};

/** `Intl.DateTimeFormat` formatters for the current language, memoized per language. */
export function useLocaleFormat(): LocaleFormat {
  const { i18n } = useTranslation();
  const lng = i18n.language;
  return useMemo(() => {
    const dateTime = new Intl.DateTimeFormat(lng, { dateStyle: 'short', timeStyle: 'medium' });
    const time = new Intl.DateTimeFormat(lng, { timeStyle: 'medium' });
    return {
      dateTime: (iso) => dateTime.format(new Date(iso)),
      time: (iso) => time.format(new Date(iso)),
    };
  }, [lng]);
}
