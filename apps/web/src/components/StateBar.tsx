/**
 * The agent-state bar at the top of the Desk: current state with its time-in-state
 * timer, the Ready / Not ready controls (Not ready asks for a reason code), and the
 * wrap-up panel with its countdown, Extend and Done buttons while in `acw`.
 *
 * Every change is a REST call (`POST /api/desk/state`, `/acw/extend`, `/acw/done`); the
 * server answers with the new presence and broadcasts it, so nothing is set optimistically
 * here — the bar shows what the server says.
 */
import type { AgentPresence } from '@cc/shared';
import {
  Button,
  ButtonGroup,
  Chip,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DeskSettings, api, post } from '../lib/api.ts';
import { formatSince, stateColor, stateKey } from '../lib/store.ts';

/** Props of {@link StateBar}. */
type Props = {
  /** The signed-in user's display name. */
  name: string;
  /** Our presence entry; `undefined` while the socket is not connected. */
  me: AgentPresence | undefined;
  /** Current time from `useNow()` so the timers tick. */
  now: number;
  /** Reports a failed request (409 `on_call`, network) to the page. */
  onError: (message: string) => void;
};

/** See the module comment. */
export function StateBar({ name, me, now, onError }: Props) {
  const { t } = useTranslation();
  const [reasonAnchor, setReasonAnchor] = useState<HTMLElement | null>(null);
  const [disposition, setDisposition] = useState('');
  const settings = useQuery({
    queryKey: ['desk-settings'],
    queryFn: () => api<DeskSettings>('/desk/settings'),
  });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  const setState = (state: 'ready' | 'not_ready', reason?: string) =>
    run(() => post('/desk/state', { state, reason }));
  const state = me?.state;
  const onCall = state === 'busy';

  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap' }} spacing={2}>
        <Typography>{t('stateBar.greeting', { name })}</Typography>
        <Chip
          color={state ? stateColor[state] : 'default'}
          label={
            state
              ? `${t(stateKey(state))}${me?.reason ? ` · ${me.reason}` : ''} · ${formatSince(me!.since, now)}`
              : t('common.connecting')
          }
        />
        <ButtonGroup disabled={!me || onCall}>
          <Button
            variant={state === 'ready' ? 'contained' : 'outlined'}
            color="success"
            onClick={() => void setState('ready')}
          >
            {t('stateBar.ready')}
          </Button>
          <Button
            variant={state === 'not_ready' ? 'contained' : 'outlined'}
            color="warning"
            onClick={(e) => setReasonAnchor(e.currentTarget)}
          >
            {t('stateBar.notReady')}
          </Button>
        </ButtonGroup>
        <Menu
          open={reasonAnchor !== null}
          anchorEl={reasonAnchor}
          onClose={() => setReasonAnchor(null)}
        >
          {(settings.data?.notReadyReasons ?? []).map((reason) => (
            <MenuItem
              key={reason}
              onClick={() => {
                setReasonAnchor(null);
                void setState('not_ready', reason);
              }}
            >
              {reason}
            </MenuItem>
          ))}
        </Menu>
      </Stack>
      {state === 'acw' && me?.acwUntil && (
        <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap' }} spacing={2}>
          <Typography color="text.secondary">
            {t('stateBar.wrapUpLeft', {
              seconds: Math.max(0, Math.ceil((Date.parse(me.acwUntil) - now) / 1000)),
            })}
          </Typography>
          {me.callId && (settings.data?.dispositions?.length ?? 0) > 0 && (
            <TextField
              select
              size="small"
              label={t('stateBar.disposition')}
              value={disposition}
              onChange={(e) => {
                setDisposition(e.target.value);
                void run(() =>
                  post(`/desk/calls/${me.callId}/disposition`, { code: e.target.value }),
                );
              }}
              sx={{ minWidth: { xs: '100%', sm: 220 } }}
            >
              {(settings.data?.dispositions ?? []).map((d) => (
                <MenuItem key={d.code} value={d.code}>
                  {d.code.includes('/') ? `${d.code.split('/')[0]} · ${d.label}` : d.label}
                </MenuItem>
              ))}
            </TextField>
          )}
          <Button size="small" onClick={() => void run(() => post('/desk/acw/extend'))}>
            {t('stateBar.extend')}
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void run(() => post('/desk/acw/done'))}
          >
            {t('stateBar.done')}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
