/**
 * i18next setup of the call button: one instance per element (several buttons on one
 * page may speak different languages), initialized synchronously from the inline
 * `locales/*.json` so the very first render is already translated.
 */
import { createI18n, normalizeLanguage } from '@cc/i18n';
import type { i18n } from 'i18next';
import de from './locales/de.json';
import en from './locales/en.json';
import it from './locales/it.json';

/**
 * A ready i18next instance for `language` (any BCP 47 tag: `de-CH` → German, unsupported
 * or empty → English). Not registered globally: pass it to `I18nextProvider`.
 */
export function createEmbedI18n(language: string | null | undefined): i18n {
  return createI18n({
    resources: { en: { translation: en }, de: { translation: de }, it: { translation: it } },
    lng: normalizeLanguage(language),
  });
}
