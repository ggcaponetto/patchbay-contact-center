/**
 * Types the translation keys of the call button: `t('callUs')` is checked against
 * `locales/en.json`, so a typo in a key or a missing interpolation fails `tsc`.
 */
import type en from './locales/en.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
