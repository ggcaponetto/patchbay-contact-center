/**
 * The i18n runtime shared by the web desk and the customer call button: the list of
 * supported languages, BCP 47 normalization (`de-CH` → `de`), the desk's language
 * cookie and a factory for i18next instances with inline resources. Translations
 * themselves live next to each app (under `src/locales/`), so this package
 * carries no strings.
 *
 * @packageDocumentation
 */
import i18next, { type Resource, type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

/** Languages the desk and the call button ship translations for; `en` is the fallback. */
export const SUPPORTED_LANGUAGES = ['en', 'de', 'it'] as const;

/** One of {@link SUPPORTED_LANGUAGES}. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Native name of each language, for language menus (never translated). */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
};

/** `de-CH` / `it_IT` → `de` / `it`; anything unsupported, empty or missing → `en`. */
export function normalizeLanguage(tag: string | null | undefined): Language {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base) ? (base as Language) : 'en';
}

/** Name of the desk cookie remembering the chosen language. */
export const LANGUAGE_COOKIE = 'cc_lng';

/**
 * The desk's language: the `cc_lng` cookie when set, else the browser's language,
 * normalized. Arguments exist for tests; the defaults read the live browser.
 */
export function detectLanguage(
  cookie: string = document.cookie,
  browserLanguage: string = navigator.language,
): Language {
  const match = new RegExp(`(?:^|;\\s*)${LANGUAGE_COOKIE}=([^;]*)`).exec(cookie);
  return normalizeLanguage(match?.[1] ?? browserLanguage);
}

/** Remembers the chosen language for a year (`path=/`, `SameSite=Lax`). */
export function persistLanguage(lng: Language): void {
  document.cookie = `${LANGUAGE_COOKIE}=${lng}; path=/; max-age=31536000; samesite=lax`;
}

/** Options of {@link createI18n}. */
export type CreateI18nOptions = {
  /** `{ en: { translation: {...} }, de: ... }` — inline, so initialization is synchronous. */
  resources: Resource;
  /** Initial language. */
  lng: Language;
  /** Namespaces present in `resources`; `translation` (the default namespace) alone when omitted. */
  ns?: string[];
  /**
   * Register the instance as react-i18next's default (`useTranslation()` without a
   * provider). The desk does; the call button relies on `I18nextProvider` per element
   * so several buttons on one page can speak different languages.
   */
  react?: boolean;
};

/**
 * A fresh, initialized i18next instance: English fallback, interpolation without HTML
 * escaping (React escapes), synchronous init (`initAsync: false`) so the first
 * render is already translated.
 */
export function createI18n({
  resources,
  lng,
  ns = ['translation'],
  react = false,
}: CreateI18nOptions): i18n {
  const instance = i18next.createInstance();
  if (react) instance.use(initReactI18next);
  void instance.init({
    resources,
    lng,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    defaultNS: 'translation',
    ns,
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}
