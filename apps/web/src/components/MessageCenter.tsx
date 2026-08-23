/**
 * Tenant-wide communications on every page: the persistent ticker banner (set by a
 * supervisor, `PUT /api/desk/ticker`) and a snackbar for the latest instant message
 * (`im` websocket frame). Rendered once in `App` so messages reach the user on any tab.
 */
import { Alert, Snackbar } from '@mui/material';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeskState } from '../lib/store.ts';

/** Props of {@link MessageCenter}. */
type Props = {
  /** The desk socket state; `ticker` and `messages` are read. */
  state: Pick<DeskState, 'ticker' | 'messages'>;
};

/** See the module comment. */
export function MessageCenter({ state }: Props) {
  const { t } = useTranslation();
  // Messages already dismissed (by count); a new arrival re-opens the snackbar.
  const [dismissed, setDismissed] = useState(0);
  const last = state.messages.at(-1);
  return (
    <>
      {state.ticker !== '' && (
        <Alert severity="info" sx={{ borderRadius: 0 }} data-testid="ticker">
          {state.ticker}
        </Alert>
      )}
      {last !== undefined && (
        <Snackbar
          key={state.messages.length}
          open={state.messages.length > dismissed}
          autoHideDuration={8000}
          onClose={() => setDismissed(state.messages.length)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        >
          <Alert severity={last.broadcast ? 'warning' : 'info'} variant="filled">
            {last.broadcast
              ? t('messages.toEveryone', { name: last.from.name })
              : t('messages.from', { name: last.from.name })}
            {last.text}
          </Alert>
        </Snackbar>
      )}
    </>
  );
}
