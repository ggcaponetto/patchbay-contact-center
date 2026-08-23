/**
 * Typed translation keys: `t('desk.accept')` is checked against the English
 * `translation` namespace (the default) and `useTranslation('settings')` against
 * `settings.json`. Other languages must carry the same keys (`locales/locales.test.ts`).
 */
import type settings from './locales/en/settings.json';
import type translation from './locales/en/translation.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof translation; settings: typeof settings };
  }
}
