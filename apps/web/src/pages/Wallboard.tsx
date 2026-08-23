/**
 * `#/wallboard` (supervisors only): read-only big-number view of the tenant for a wall
 * screen — waiting and active calls, agents by state, today's totals — with the
 * threshold alerts on top. Polls `GET /api/desk/stats` every five seconds.
 */
import { Alert, Grid, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type TenantStats, api } from '../lib/api.ts';

/** One big number with its caption. */
function Big({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <Paper sx={{ p: 3, textAlign: 'center' }}>
      <Typography variant="h2" color={alert ? 'error' : 'primary'}>
        {value}
      </Typography>
      <Typography color="text.secondary">{label}</Typography>
    </Paper>
  );
}

/** See the module comment. */
export function Wallboard() {
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<TenantStats>('/desk/stats'),
    refetchInterval: 5000,
  });
  const s = stats.data;
  if (!s) return <Typography color="text.secondary">Loading…</Typography>;
  const alerting = s.alerts.length > 0;
  return (
    <Stack spacing={2}>
      {s.alerts.map((a) => (
        <Alert key={a} severity="error" variant="filled">
          {a}
        </Alert>
      ))}
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Waiting" value={s.waiting} alert={alerting} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Longest wait (s)" value={s.longestWaitSec} alert={alerting} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Active calls" value={s.active} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Longest call (s)" value={s.longestCallSec} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Agents ready" value={s.agents.ready} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="On calls" value={s.agents.busy} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Wrap-up" value={s.agents.acw} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Big label="Not ready" value={s.agents.notReady} />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Big label="Calls today" value={s.today.calls} />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Big label="Answered by a human" value={s.today.answered} />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Big label="Avg handle time (s)" value={s.today.avgHandleSec} />
        </Grid>
      </Grid>
    </Stack>
  );
}
