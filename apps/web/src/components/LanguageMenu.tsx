/**
 * The language selector in the app bar: switches the desk to English, German or
 * Italian at runtime (`i18n.changeLanguage`) and remembers the choice in the `cc_lng`
 * cookie (`persistLanguage`), which `detectLanguage()` reads at the next boot.
 */
import { LANGUAGE_NAMES, type Language, SUPPORTED_LANGUAGES, persistLanguage } from '@cc/i18n';
import { MenuItem, Select } from '@mui/material';
import { useTranslation } from 'react-i18next';

/** See the module comment. */
export function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const change = (lng: Language) => {
    void i18n.changeLanguage(lng);
    persistLanguage(lng);
  };
  return (
    <Select
      size="small"
      value={i18n.language}
      onChange={(e) => change(e.target.value as Language)}
      inputProps={{ 'aria-label': t('app.language') }}
    >
      {SUPPORTED_LANGUAGES.map((lng) => (
        <MenuItem key={lng} value={lng} lang={lng}>
          {LANGUAGE_NAMES[lng]}
        </MenuItem>
      ))}
    </Select>
  );
}
