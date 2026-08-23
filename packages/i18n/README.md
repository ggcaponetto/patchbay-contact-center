# @cc/i18n

The i18n runtime shared by the web desk (`apps/web`) and the customer call button
(`apps/embed`): which languages exist, how a browser tag maps onto them, where the desk
remembers the choice, and how an [i18next](https://www.i18next.com/) instance is built.
Translations are **not** here — each app keeps its own JSON files under `src/locales/` (the desk
splits them into a `translation` and a `settings` namespace) and gets typed keys from
its English files (see `src/i18next.d.ts` in each app).

| Export                                      | What                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPPORTED_LANGUAGES`                       | `['en', 'de', 'it']`; `en` is the fallback for every missing key                                                                                                                                           |
| `LANGUAGE_NAMES`                            | Native names for language menus (`Deutsch`, …), never translated                                                                                                                                           |
| `normalizeLanguage(tag)`                    | `de-CH` → `de`, `it_IT` → `it`, unknown/empty → `en`                                                                                                                                                       |
| `LANGUAGE_COOKIE`                           | `cc_lng`, the desk's choice; the e2e suite pins it to `en` per browser context                                                                                                                             |
| `detectLanguage()`                          | Cookie, else `navigator.language`, normalized                                                                                                                                                              |
| `persistLanguage(lng)`                      | Writes the cookie (one year, `path=/`, `SameSite=Lax`)                                                                                                                                                     |
| `createI18n({ resources, lng, ns, react })` | An initialized instance with inline resources (synchronous, no loading state); `ns` lists the namespaces in `resources` (default `['translation']`); `react: true` registers it as react-i18next's default |

## How each app uses it

```mermaid
flowchart LR
  subgraph web[apps/web]
    locales1[locales/*/*.json] --> create1[createWebI18n]
    cookie[cc_lng cookie / navigator.language] --> detect[detectLanguage]
    detect --> create1
    create1 --> provider1[I18nextProvider + MUI locale]
  end
  subgraph embed[apps/embed]
    attr[language attribute / html lang / navigator] --> norm[normalizeLanguage]
    locales2[locales/*.json] --> create2[createI18n per element]
    norm --> create2
    create2 --> provider2[I18nextProvider]
  end
  runtime[@cc/i18n] --> create1 & create2
```

- **Desk**: `detectLanguage()` at boot, `<I18nextProvider>` in `main.tsx`, a language menu in
  the app bar calling `i18n.changeLanguage` + `persistLanguage`. `react: true` so
  `useTranslation()` works everywhere (and in tests without a provider).
- **Call button**: the `language` attribute (or the host page's `<html lang>`, or the
  browser) is normalized and an instance is created **per element** with
  `react: false`, so two buttons on one page can show different languages.

## Adding a language

1. Append it to `SUPPORTED_LANGUAGES` and `LANGUAGE_NAMES`.
2. Add the `<lng>` JSON files under `src/locales/` of both apps (the locale tests enforce identical key sets).
3. Wire the MUI locale bundle in `apps/web/src/lib/i18n.ts` and add the JSON file to
   `cspell.json` `ignorePaths`.
