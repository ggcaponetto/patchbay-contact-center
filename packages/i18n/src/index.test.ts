// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  LANGUAGE_COOKIE,
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  createI18n,
  detectLanguage,
  normalizeLanguage,
  persistLanguage,
} from './index.ts';

describe('@cc/i18n', () => {
  afterEach(() => {
    document.cookie = `${LANGUAGE_COOKIE}=; path=/; max-age=0`;
  });

  it('normalizes BCP 47 tags to a supported language, falling back to English', () => {
    expect(normalizeLanguage('de-CH')).toBe('de');
    expect(normalizeLanguage('it_IT')).toBe('it');
    expect(normalizeLanguage('EN-us')).toBe('en');
    expect(normalizeLanguage('fr')).toBe('en');
    expect(normalizeLanguage('')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage(null)).toBe('en');
    for (const l of SUPPORTED_LANGUAGES) expect(LANGUAGE_NAMES[l]).toBeTruthy();
  });

  it('detects the language from the cookie, else the browser, and persists it', () => {
    expect(detectLanguage('', 'it-IT')).toBe('it');
    expect(detectLanguage('other=1; cc_lng=de', 'it-IT')).toBe('de');
    expect(detectLanguage('cc_lng=xx', 'it-IT')).toBe('en');
    persistLanguage('it');
    expect(document.cookie).toContain('cc_lng=it');
    expect(detectLanguage()).toBe('it');
  });

  it('creates initialized instances with inline resources and English fallback', () => {
    const resources = {
      en: { translation: { hello: 'Hello {{name}}', only: 'English only' } },
      de: { translation: { hello: 'Hallo {{name}}' } },
    };
    const de = createI18n({ resources, lng: 'de' });
    expect(de.t('hello', { name: 'Ann' })).toBe('Hallo Ann');
    expect(de.t('only')).toBe('English only');
    const en = createI18n({ resources, lng: 'en', react: true });
    expect(en.t('hello', { name: '<b>' })).toBe('Hello <b>');
    expect(en.language).toBe('en');
    expect(de.language).toBe('de');
  });

  it('loads extra namespaces when asked', () => {
    const i18n = createI18n({
      resources: { en: { translation: { a: 'A' }, settings: { b: 'B' } } },
      lng: 'en',
      ns: ['translation', 'settings'],
    });
    expect(i18n.t('a')).toBe('A');
    expect(i18n.t('b', { ns: 'settings' })).toBe('B');
    expect(i18n.t('settings:b')).toBe('B');
  });
});
