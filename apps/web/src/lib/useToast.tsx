/**
 * One app-wide snackbar for "Saved" / error feedback. `ToastProvider` mounts the MUI
 * `Snackbar` once (in `App.tsx`); `useToast()` returns a function any component can call.
 * Mutations in the settings cards use it so every save visibly succeeds or fails.
 */
import { Alert, Snackbar } from '@mui/material';
import type { i18n } from 'i18next';
import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';

/** Shows `message` for a few seconds; `severity` defaults to `success`. */
export type Toast = (message: string, severity?: 'success' | 'error' | 'info') => void;

const ToastContext = createContext<Toast>(() => undefined);

/** Renders children plus the single snackbar they share. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{
    key: number;
    message: string;
    severity: 'success' | 'error' | 'info';
  } | null>(null);
  const show = useCallback<Toast>((message, severity = 'success') => {
    setToast({ key: Date.now(), message, severity });
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <Snackbar
        key={toast?.key}
        open={toast !== null}
        autoHideDuration={toast?.severity === 'error' ? 8000 : 3000}
        onClose={(_e, reason) => reason !== 'clickaway' && setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity ?? 'success'} onClose={() => setToast(null)} role="status">
          {toast?.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

/** The toast function of the nearest {@link ToastProvider} (a no-op without one). */
export function useToast(): Toast {
  return useContext(ToastContext);
}

/**
 * Human text for a failed request. The API answers with a code (`invalid_body`); with
 * an `i18n` instance the code is translated through `errors.<code>` when such a key
 * exists (and an empty error becomes `errors.generic`), otherwise the bare code is
 * returned: `Error: invalid_body` becomes `invalid_body`.
 */
export function errorText(error: unknown, i18n?: i18n): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = text.replace(/^Error:\s*/, '');
  if (!code) return i18n ? i18n.t('errors.generic') : 'Something went wrong';
  return i18n?.exists(`errors.${code}`) ? i18n.t(`errors.${code}` as 'errors.generic') : code;
}
