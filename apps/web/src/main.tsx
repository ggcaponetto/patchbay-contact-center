/**
 * Browser entry point of the agent desk (referenced from `index.html`).
 *
 * {@link Providers} sets up everything every page relies on and `main` mounts
 * {@link App} inside it:
 * - i18next (`lib/i18n.ts`) in the language `detectLanguage()` finds (the `cc_lng`
 *   cookie, else the browser), through `I18nextProvider`; `<html lang>` follows.
 * - MUI theme with a dark color scheme available (follows the OS preference) and the
 *   MUI locale bundle of the current language, plus `CssBaseline`.
 * - `ToastProvider`: the one snackbar every save confirms itself in.
 * - A TanStack Query client: one retry, data considered fresh for 5 s. Pages re-fetch by
 *   changing query keys (see `callsVersion` in `lib/store.ts`) rather than polling.
 *
 * Before anything renders, `bootDevUser()` adopts a dev identity named in the URL
 * (`#/?as=email`, see `lib/devUser.ts`), so the very first request is already that person.
 */
import { type Language, detectLanguage, normalizeLanguage } from '@cc/i18n';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { App } from './App.tsx';
import { bootDevUser } from './lib/devUser.ts';
import { MUI_LOCALES, createWebI18n } from './lib/i18n.ts';
import { ToastProvider } from './lib/useToast.tsx';

/** Theme in the current language; re-created when the language menu switches it. */
function LocalizedTheme({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const lng: Language = normalizeLanguage(i18n.language);
  const theme = useMemo(
    () => createTheme({ colorSchemes: { dark: true } }, MUI_LOCALES[lng]),
    [lng],
  );
  useEffect(() => {
    document.documentElement.lang = lng;
  }, [lng]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

/** The provider tree of the desk (i18n, theme, query client, toasts). See the module comment. */
export function Providers({ children }: { children: ReactNode }) {
  const [i18n] = useState(() => createWebI18n(detectLanguage()));
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
  );
  return (
    <I18nextProvider i18n={i18n}>
      <LocalizedTheme>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </LocalizedTheme>
    </I18nextProvider>
  );
}

bootDevUser();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
