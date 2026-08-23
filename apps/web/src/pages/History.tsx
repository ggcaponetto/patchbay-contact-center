/**
 * `#/history`: table of all calls of the tenant, newest first as returned by the API.
 */
import {
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { type CallSummary, type DeskSettings, api } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import { useLocaleFormat } from '../lib/i18n.ts';
import {
  dispositionLabel,
  formatDuration,
  skillLabel,
  statusColor,
  statusKey,
} from '../lib/store.ts';

/** Props of {@link History}. */
type Props = { desk: ReturnType<typeof useDeskSocket> };

/**
 * Past and current calls of the tenant; click a row for the full conversation.
 *
 * Uses `GET /api/desk/calls` with query key `['calls', callsVersion]` so every
 * `call.updated` websocket frame triggers a re-fetch. Durations of live calls tick via
 * `useNow`. Rows navigate to `#/calls/<id>` on click, Enter or Space (they are focusable
 * and labelled); the Skills and Summary columns are hidden on phones and the table scrolls sideways
 * inside its container rather than the page.
 */
export function History({ desk }: Props) {
  const { t } = useTranslation();
  const { dateTime } = useLocaleFormat();
  const now = useNow();
  const calls = useQuery({
    queryKey: ['calls', desk.state.callsVersion],
    queryFn: () => api<CallSummary[]>('/desk/calls'),
  });
  const settings = useQuery({
    queryKey: ['desk-settings'],
    queryFn: () => api<DeskSettings>('/desk/settings'),
  });
  const open = (id: string) => (location.hash = `#/calls/${id}`);
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h5" component="h1" gutterBottom>
        {t('history.title')}
      </Typography>
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('history.started')}</TableCell>
              <TableCell>{t('history.queue')}</TableCell>
              <TableCell>{t('history.status')}</TableCell>
              <TableCell>{t('history.duration')}</TableCell>
              <TableCell>{t('history.disposition')}</TableCell>
              <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                {t('history.columns.skills')}
              </TableCell>
              <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                {t('history.summary')}
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(calls.data ?? []).map((c) => (
              <TableRow
                key={c.id}
                hover
                tabIndex={0}
                aria-label={t('history.openCall', { queue: c.queueKey, id: c.id.slice(0, 8) })}
                sx={{ cursor: 'pointer' }}
                onClick={() => open(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(c.id);
                  }
                }}
              >
                <TableCell>{dateTime(c.startedAt)}</TableCell>
                <TableCell>{c.queueKey}</TableCell>
                <TableCell>
                  <Chip size="small" color={statusColor[c.status]} label={t(statusKey(c.status))} />
                </TableCell>
                <TableCell>{formatDuration(c.startedAt, c.endedAt, now)}</TableCell>
                <TableCell>
                  {c.dispositionCode
                    ? dispositionLabel(c.dispositionCode, settings.data?.dispositions)
                    : ''}
                </TableCell>
                <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                    {(c.requiredSkills ?? []).map((key) => (
                      <Chip
                        key={key}
                        size="small"
                        variant="outlined"
                        label={skillLabel(key, settings.data?.skills, t)}
                      />
                    ))}
                  </Stack>
                </TableCell>
                <TableCell sx={{ maxWidth: 420, display: { xs: 'none', md: 'table-cell' } }}>
                  {c.aiSummary ?? ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
