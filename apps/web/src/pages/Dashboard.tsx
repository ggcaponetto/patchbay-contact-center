/**
 * `#/dashboard` (supervisors only): live calls and agent states at a glance, the
 * supervisor's force-state actions (Ready, Not ready, end wrap-up, log out) and
 * messaging per agent, plus team messaging (broadcast and the ticker banner).
 */
import type { AgentPresence } from '@cc/shared';
import {
  Alert,
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
import { Stack, TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type CallSummary, type TenantStats, api, post, put } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import {
  formatDuration,
  formatSince,
  stateColor,
  stateKey,
  statusColor,
  statusKey,
} from '../lib/store.ts';

/** Props of {@link Dashboard}. */
type Props = { desk: ReturnType<typeof useDeskSocket> };

/** The "…" menu on an agent row: force state (`POST /agents/:userId/state`) and IM. */
function ForceState({ agent }: { agent: AgentPresence }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const force = (body: { state: 'ready' | 'not_ready' | 'logged_out'; reason?: string }) => {
    setAnchor(null);
    void post(`/desk/agents/${agent.userId}/state`, body).catch(() => undefined);
  };
  const sendMessage = () => {
    const text = (message ?? '').trim();
    setMessage(null);
    if (text) {
      void post('/desk/messages', { text, toUserId: agent.userId }).catch(() => undefined);
    }
  };
  return (
    <>
      <Button
        size="small"
        aria-label={t('dashboard.actionsFor', { name: agent.name })}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        …
      </Button>
      <Menu open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)}>
        <MenuItem disabled={agent.state === 'busy'} onClick={() => force({ state: 'ready' })}>
          {agent.state === 'acw' ? t('dashboard.endWrapUp') : t('dashboard.forceReady')}
        </MenuItem>
        <MenuItem
          disabled={agent.state === 'busy'}
          onClick={() => force({ state: 'not_ready', reason: 'Supervisor' })}
        >
          {t('dashboard.forceNotReady')}
        </MenuItem>
        <MenuItem onClick={() => force({ state: 'logged_out' })}>{t('dashboard.logOut')}</MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            setMessage('');
          }}
        >
          {t('dashboard.message')}
        </MenuItem>
      </Menu>
      {message !== null && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <TextField
            size="small"
            autoFocus
            label={t('dashboard.messageTo', { name: agent.name })}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />
          <Button onClick={sendMessage} disabled={!message.trim()}>
            {t('common.send')}
          </Button>
        </Stack>
      )}
    </>
  );
}

/** Team messaging: broadcast an instant message and set / clear the ticker banner. */
function TeamMessaging({ ticker }: { ticker: string }) {
  const { t } = useTranslation();
  const [broadcast, setBroadcast] = useState('');
  const [tickerText, setTickerText] = useState(ticker);
  const sendBroadcast = () => {
    const text = broadcast.trim();
    setBroadcast('');
    if (text) void post('/desk/messages', { text }).catch(() => undefined);
  };
  return (
    <Paper sx={{ p: 2, mt: 2 }}>
      <Typography variant="h6" gutterBottom>
        {t('dashboard.teamMessaging')}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <TextField
          size="small"
          label={t('dashboard.broadcastLabel')}
          value={broadcast}
          onChange={(e) => setBroadcast(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendBroadcast()}
          sx={{ flex: 1 }}
        />
        <Button variant="outlined" onClick={sendBroadcast} disabled={!broadcast.trim()}>
          {t('dashboard.broadcast')}
        </Button>
      </Stack>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label={t('dashboard.tickerLabel')}
          value={tickerText}
          onChange={(e) => setTickerText(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button
          variant="outlined"
          onClick={() =>
            void put('/desk/ticker', { text: tickerText.trim() }).catch(() => undefined)
          }
        >
          {t('dashboard.setTicker')}
        </Button>
      </Stack>
    </Paper>
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
  const { t } = useTranslation();
  const now = useNow();
  const calls = useQuery({
    queryKey: ['calls', desk.state.callsVersion],
    queryFn: () => api<CallSummary[]>('/desk/calls'),
  });
  const live = (calls.data ?? []).filter((c) => c.status !== 'ended');
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<TenantStats>('/desk/stats'),
    refetchInterval: 5000,
  });

  return (
    <Grid container spacing={2}>
      {(stats.data?.alerts ?? []).map((a) => (
        <Grid key={a} size={12}>
          <Alert severity="error">{a}</Alert>
        </Grid>
      ))}
      <Grid size={{ xs: 12, md: 7 }}>
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            {t('dashboard.liveCalls', { count: live.length })}
          </Typography>
          <List dense>
            {live.length === 0 && <ListItemText secondary={t('dashboard.noCalls')} />}
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
                    label={t(statusKey(desk.state.callStatus[c.id] ?? c.status))}
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
            {t('dashboard.agentsOnline', { count: desk.state.agents.length })}
          </Typography>
          <List dense>
            {desk.state.agents.length === 0 && (
              <ListItemText secondary={t('dashboard.nobodyOnline')} />
            )}
            {desk.state.agents.map((a) => (
              <ListItem key={a.userId} secondaryAction={<ForceState agent={a} />}>
                <ListItemText
                  primary={a.name}
                  secondary={`${a.reason ? `${a.reason} · ` : ''}${formatSince(a.since, now)}`}
                />
                <Chip
                  size="small"
                  color={stateColor[a.state]}
                  label={t(stateKey(a.state))}
                  sx={{ mr: 5 }}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
        <TeamMessaging ticker={desk.state.ticker} />
      </Grid>
    </Grid>
  );
}
