/**
 * `#/calls/<id>`: one call in detail. Agents see the transcript, AI summary and event
 * log; supervisors can additionally monitor (listen / whisper / barge) or take the
 * call (take over / intercept) while it is live.
 */
import { Button, Chip, Grid, Paper, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { CallPanel, type JoinInfo, Transcript } from '../components/CallPanel.tsx';
import { type CallDetail, api, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { statusColor, statusLabel } from '../lib/store.ts';

/** Supervisor ways onto a live call; see `Flow.join` on the API for the semantics. */
type JoinMode = 'listen' | 'whisper' | 'barge' | 'takeover' | 'intercept';

/** Button labels, in display order. */
const MODE_LABELS: Record<JoinMode, string> = {
  listen: 'Listen in',
  whisper: 'Whisper',
  barge: 'Barge in',
  takeover: 'Take over',
  intercept: 'Intercept',
};

/** Panel title while joined in each mode. */
const MODE_TITLES: Record<JoinMode, string> = {
  listen: 'Listening in',
  whisper: 'Whispering to the agent',
  barge: 'Barged into this call',
  takeover: 'You took over this call',
  intercept: 'You intercepted this call',
};

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
  const [joined, setJoined] = useState<{ mode: JoinMode; join: JoinInfo } | null>(null);
  useEffect(() => send({ type: 'subscribe', callId: id }), [id, send]);

  // Prefer the status pushed over the socket; the fetched row may be a few ms behind.
  const status = state.callStatus[id] ?? detail.data?.status;
  const live = status !== undefined && status !== 'ended';
  const join = async (mode: JoinMode) => {
    const res = await post<{ token: string; url: string }>(`/desk/calls/${id}/join`, { mode });
    setJoined({ mode, join: { ...res, publish: mode !== 'listen' } });
  };
  const leave = useCallback(async () => {
    if (!joined) return;
    const role = joined.mode === 'takeover' || joined.mode === 'intercept' ? 'human' : 'supervisor';
    setJoined(null);
    await post(`/desk/calls/${id}/leave`, { role }).catch(() => undefined);
  }, [id, joined]);

  // Transcript merge. The API persists every segment it broadcasts, so the stored rows
  // overlap with the live segments received over the socket — but only partially when
  // the page was opened mid-call (stored has segments live never saw) or when live
  // segments arrived after the last fetch. Each live segment cancels one identical
  // stored row; what remains is the tail the fetch has not caught up with yet.
  const stored = (detail.data?.transcript ?? []).map((t) => ({
    speaker: t.speaker as 'ai',
    identity: t.identity,
    text: t.text,
  }));
  const liveSegments = state.transcripts[id] ?? [];
  const seen = new Map<string, number>();
  for (const t of stored)
    seen.set(
      `${t.identity}
${t.text}`,
      (seen.get(`${t.identity}
${t.text}`) ?? 0) + 1,
    );
  const tail = liveSegments.filter((s) => {
    const k = `${s.identity}
${s.text}`;
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    return n === 0;
  });
  const transcript = [...stored, ...tail];

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={2}>
        <Button onClick={() => (location.hash = '#/history')}>← Back</Button>
        <Typography variant="h6">Call {id.slice(0, 8)}</Typography>
        {status && <Chip size="small" color={statusColor[status]} label={statusLabel[status]} />}
        {detail.data && <Typography color="text.secondary">{detail.data.queueKey}</Typography>}
        {detail.data?.dispositionCode && (
          <Chip size="small" variant="outlined" label={detail.data.dispositionCode} />
        )}
        {(detail.data?.tags ?? []).map((t) => (
          <Chip key={t} size="small" label={t} />
        ))}
        <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
          {supervisor && live && !joined
            ? (Object.keys(MODE_TITLES) as JoinMode[]).map((mode) => (
                <Button
                  key={mode}
                  variant={mode === 'takeover' ? 'contained' : 'outlined'}
                  onClick={() => void join(mode)}
                >
                  {MODE_LABELS[mode]}
                </Button>
              ))
            : null}
        </Stack>
      </Stack>
      {joined ? (
        <CallPanel
          join={joined.join}
          title={MODE_TITLES[joined.mode]}
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
