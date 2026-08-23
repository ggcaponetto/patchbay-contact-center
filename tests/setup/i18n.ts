/**
 * Vitest setup for the `unit` project: registers the desk's English i18next instance as
 * react-i18next's default, so components rendered without an `I18nextProvider` (every
 * web unit test) show the English texts the assertions look for.
 */
import { createWebI18n } from '../../apps/web/src/lib/i18n.ts';

createWebI18n('en');
