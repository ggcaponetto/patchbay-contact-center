/**
 * `#/wallboard` (supervisors only): read-only big-number view of the tenant for a wall
 * screen — waiting and active calls, agents by state, today's totals — with the
 * threshold alerts on top. Polls `GET /api/desk/stats` every five seconds.
 */
import { Alert, Grid, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { type TenantStats, api } from '../lib/api.ts';

/** One big number with its caption. */
function Big({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <Paper sx={{ p: 3, textAlign: 'center' }}>
      <Typography variant="h2" component="div" color={alert ? 'error' : 'primary'}>
        {value}
      </Typography>
      <Typography color="text.secondary">{label}</Typography>
    </Paper>
  );
}

/** See the module comment. */
export function Wallboard() {
  const { t } = useTranslation();
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<TenantStats>('/desk/stats'),
    refetchInterval: 5000,
  });
  const s = stats.data;
  const title = (
    <Typography variant="h5" component="h1">
      {t('wallboard.title')}
    </Typography>
  );
  if (!s)
    return (
      <Stack spacing={2}>
        {title}
        <Typography color="text.secondary">{t('common.loading')}</Typography>
      </Stack>
    );
  const alerting = s.alerts.length > 0;
  return (
    <Stack spacing={2}>
      {title}
      {s.alerts.map((a) => (
        <Alert key={a} severity="error" variant="filled">
          {a}
        </Alert>
      ))}
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.waiting')} value={s.waiting} alert={alerting} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.longestWait')} value={s.longestWaitSec} alert={alerting} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.activeCalls')} value={s.active} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.longestCall')} value={s.longestCallSec} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.agentsReady')} value={s.agents.ready} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.onCalls')} value={s.agents.busy} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.wrapUp')} value={s.agents.acw} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label={t('wallboard.notReady')} value={s.agents.notReady} />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Big label={t('wallboard.callsToday')} value={s.today.calls} />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Big label={t('wallboard.answeredByHuman')} value={s.today.answered} />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Big label={t('wallboard.avgHandleTime')} value={s.today.avgHandleSec} />
        </Grid>
      </Grid>
    </Stack>
  );
}
