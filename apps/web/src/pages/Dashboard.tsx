/**
 * `#/dashboard` (supervisors only): live calls and agent states at a glance, with the
 * supervisor's force-state actions (Ready, Not ready, end wrap-up, log out) per agent.
 */
import type { AgentPresence } from '@cc/shared';
import {
  Button,
  Chip,
  Grid,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type CallSummary, api, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import {
  formatDuration,
  formatSince,
  stateColor,
  stateLabel,
  statusColor,
  statusLabel,
} from '../lib/store.ts';

/** Props of {@link Dashboard}. */
type Props = { desk: ReturnType<typeof useDeskSocket> };

/** The "…" menu on an agent row: `POST /api/desk/agents/:userId/state`. */
function ForceState({ agent }: { agent: AgentPresence }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const force = (body: { state: 'ready' | 'not_ready' | 'logged_out'; reason?: string }) => {
    setAnchor(null);
    void post(`/desk/agents/${agent.userId}/state`, body).catch(() => undefined);
  };
  return (
    <>
      <Button
        size="small"
        aria-label={`actions for ${agent.name}`}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        …
      </Button>
      <Menu open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)}>
        <MenuItem disabled={agent.state === 'busy'} onClick={() => force({ state: 'ready' })}>
          {agent.state === 'acw' ? 'End wrap-up' : 'Force ready'}
        </MenuItem>
        <MenuItem
          disabled={agent.state === 'busy'}
          onClick={() => force({ state: 'not_ready', reason: 'Supervisor' })}
        >
          Force not ready
        </MenuItem>
        <MenuItem onClick={() => force({ state: 'logged_out' })}>Log out</MenuItem>
      </Menu>
    </>
  );
}

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
              <ListItem key={a.userId} secondaryAction={<ForceState agent={a} />}>
                <ListItemText
                  primary={a.name}
                  secondary={`${a.reason ? `${a.reason} · ` : ''}${formatSince(a.since, now)}`}
                />
                <Chip
                  size="small"
                  color={stateColor[a.state]}
                  label={stateLabel[a.state]}
                  sx={{ mr: 5 }}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      </Grid>
    </Grid>
  );
}
