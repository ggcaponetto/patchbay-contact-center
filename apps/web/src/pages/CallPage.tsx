/**
 * `#/calls/<id>`: one call in detail. Agents see the transcript, AI summary and event
 * log; supervisors can additionally listen in or take over while the call is live.
 */
import { Button, Chip, Grid, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { CallPanel, type JoinInfo, Transcript } from '../components/CallPanel.tsx';
import { type CallDetail, api, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { statusColor, statusLabel } from '../lib/store.ts';

/** Props of {@link CallPage}: the call id from the route and the supervisor flag from the membership. */
type Props = { id: string; desk: ReturnType<typeof useDeskSocket>; supervisor: boolean };

/**
 * One call: transcript, events, and (for supervisors) listen-in / take-over while live.
 *
 * Uses:
 * - `GET /api/desk/calls/:id` (query key includes `callsVersion`, so every
 *   `call.updated` frame re-fetches the detail).
 * - WS `subscribe` on mount so `transcript` frames for this call are reduced into
 *   `state.transcripts[id]`.
 * - `POST /api/desk/calls/:id/join` with `mode: 'listen' | 'takeover'` (supervisors);
 *   listen does not publish the microphone, take-over does.
 * - `POST /api/desk/calls/:id/leave` with `role: 'supervisor'` (listen) or `'human'`
 *   (take-over; ends the call).
 */
export function CallPage({ id, desk, supervisor }: Props) {
  const { state, send } = desk;
  const detail = useQuery({
    queryKey: ['call', id, state.callsVersion],
    queryFn: () => api<CallDetail>(`/desk/calls/${id}`),
  });
  const [joined, setJoined] = useState<{ mode: 'listen' | 'takeover'; join: JoinInfo } | null>(
    null,
  );
  useEffect(() => send({ type: 'subscribe', callId: id }), [id, send]);

  // Prefer the status pushed over the socket; the fetched row may be a few ms behind.
  const status = state.callStatus[id] ?? detail.data?.status;
  const live = status !== undefined && status !== 'ended';
  const join = async (mode: 'listen' | 'takeover') => {
    const res = await post<{ token: string; url: string }>(`/desk/calls/${id}/join`, { mode });
    setJoined({ mode, join: { ...res, publish: mode === 'takeover' } });
  };
  const leave = useCallback(async () => {
    if (!joined) return;
    const role = joined.mode === 'listen' ? 'supervisor' : 'human';
    setJoined(null);
    await post(`/desk/calls/${id}/leave`, { role }).catch(() => undefined);
  }, [id, joined]);

  // Transcript merge. The API persists every segment it broadcasts, so after a re-fetch
  // the stored rows already contain the first N live segments we received over the
  // socket. Both lists are append-only and in the same order, so the live tail after
  // `stored.length` is exactly what the fetch has not caught up with yet.
  const stored = (detail.data?.transcript ?? []).map((t) => ({
    speaker: t.speaker as 'ai',
    identity: t.identity,
    text: t.text,
  }));
  const liveSegments = state.transcripts[id] ?? [];
  // Stored rows already include live segments that arrived before the last fetch.
  const transcript = [...stored, ...liveSegments.slice(stored.length)];

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={2}>
        <Button onClick={() => (location.hash = '#/history')}>← Back</Button>
        <Typography variant="h6">Call {id.slice(0, 8)}</Typography>
        {status && <Chip size="small" color={statusColor[status]} label={statusLabel[status]} />}
        {detail.data && <Typography color="text.secondary">{detail.data.queueKey}</Typography>}
        <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
          {supervisor && live && !joined && (
            <>
              <Button variant="outlined" onClick={() => void join('listen')}>
                Listen in
              </Button>
              <Button variant="contained" onClick={() => void join('takeover')}>
                Take over
              </Button>
            </>
          )}
        </Stack>
      </Stack>
      {joined ? (
        <CallPanel
          join={joined.join}
          title={joined.mode === 'listen' ? 'Listening in' : 'You took over this call'}
          transcript={transcript}
          onLeave={() => void leave()}
        />
      ) : (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 8 }}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" gutterBottom>
                Transcript
              </Typography>
              <Transcript segments={transcript} />
              {detail.data?.aiSummary && (
                <Typography sx={{ mt: 2 }}>
                  <b>AI summary:</b> {detail.data.aiSummary}
                </Typography>
              )}
            </Paper>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="subtitle1" gutterBottom>
                Events
              </Typography>
              {(detail.data?.events ?? []).map((e) => (
                <Typography key={e.id} variant="body2" sx={{ mb: 0.5 }}>
                  <span style={{ opacity: 0.6 }}>{new Date(e.at).toLocaleTimeString()}</span>{' '}
                  {e.type}
                </Typography>
              ))}
            </Paper>
          </Grid>
        </Grid>
      )}
    </Stack>
  );
}
