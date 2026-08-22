/**
 * `#/dashboard` (supervisors only): live calls and agent presence at a glance.
 */
import {
  Chip,
  Grid,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type CallSummary, api } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import { formatDuration, statusColor, statusLabel } from '../lib/store.ts';

/** Props of {@link Dashboard}. */
type Props = { desk: ReturnType<typeof useDeskSocket> };

/** Chip color per agent presence status. */
const agentColor = { available: 'success', busy: 'warning', away: 'default' } as const;

/**
 * Supervisor overview: live calls and who is online. Refetched on every call update.
 *
 * Uses `GET /api/desk/calls` (query key `['calls', callsVersion]`, filtered to
 * non-ended calls) and the WS `presence` broadcast (`desk.state.agents`). The status
 * chip prefers the socket's `callStatus` over the fetched row. Clicking a call opens
 * `#/calls/<id>`.
 */
export function Dashboard({ desk }: Props) {
  const now = useNow();
  const calls = useQuery({
    queryKey: ['calls', desk.state.callsVersion],
    queryFn: () => api<CallSummary[]>('/desk/calls'),
  });
  const live = (calls.data ?? []).filter((c) => c.status !== 'ended');

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 7 }}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            Live calls ({live.length})
          </Typography>
          <List dense>
            {live.length === 0 && <ListItemText secondary="No calls in progress." />}
            {live.map((c) => (
              <ListItem key={c.id} disablePadding>
                <ListItemButton onClick={() => (location.hash = `#/calls/${c.id}`)}>
                  <ListItemText
                    primary={`${c.queueKey} · ${formatDuration(c.startedAt, c.endedAt, now)}`}
                    secondary={String(c.customerMeta['page'] ?? '')}
                  />
                  <Chip
                    size="small"
                    color={statusColor[c.status]}
                    label={statusLabel[desk.state.callStatus[c.id] ?? c.status]}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      </Grid>
      <Grid size={{ xs: 12, md: 5 }}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            Agents online ({desk.state.agents.length})
          </Typography>
          <List dense>
            {desk.state.agents.length === 0 && <ListItemText secondary="Nobody is online." />}
            {desk.state.agents.map((a) => (
              <ListItem key={a.userId}>
                <ListItemText primary={a.name} secondary={a.callId ? 'On a call' : undefined} />
                <Chip size="small" color={agentColor[a.status]} label={a.status} />
              </ListItem>
            ))}
          </List>
        </Paper>
      </Grid>
    </Grid>
  );
}
