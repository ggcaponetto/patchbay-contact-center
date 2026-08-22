/**
 * `#/desk`: the page every agent lives on. The {@link StateBar} (Ready / Not ready,
 * wrap-up), the incoming-call dialog with its countdown and, once accepted, the
 * {@link CallPanel} for the active call. State comes from the desk websocket
 * (`desk.state`), every action happens over REST.
 */
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { CallNotes } from '../components/CallNotes.tsx';
import { CallPanel, type JoinInfo } from '../components/CallPanel.tsx';
import { StateBar } from '../components/StateBar.tsx';
import { type CallDetail, type DeskSettings, type Me, api, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import { myPresence, secondsLeft } from '../lib/store.ts';

/**
 * The zip tone announcing an auto-answered call: a short 880 Hz beep via WebAudio.
 * Silently does nothing where WebAudio is unavailable (tests).
 */
function zipTone(): void {
  if (typeof AudioContext === 'undefined') return;
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.2;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
  osc.onended = () => void ctx.close();
}

/** Props of {@link Desk}. */
type Props = { desk: ReturnType<typeof useDeskSocket>; me: Me };

/**
 * The agent's workplace: state bar, incoming offers, the active call.
 *
 * Uses:
 * - `POST /api/desk/state`, `/acw/*` from the {@link StateBar}; the server echoes the
 *   new state in the `presence` frame (`myPresence`).
 * - WS `call.offer` / `call.offer.cancelled` (already reduced into `state.offer`).
 * - `POST /api/desk/calls/:id/accept` to answer; returns `{ token, url }`.
 * - WS `subscribe` so live transcript segments of the call start arriving.
 * - WS `offer.decline` to pass the call to the next agent.
 * - `POST /api/desk/calls/:id/leave` (`role: 'human'`) when hanging up; a human leaving
 *   ends the call server-side and puts the agent into wrap-up.
 */
export function Desk({ desk, me }: Props) {
  const { state, dispatch, send } = desk;
  const [active, setActive] = useState<{ callId: string; join: JoinInfo } | null>(null);
  const [heldAt, setHeldAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settings = useQuery({
    queryKey: ['desk-settings'],
    queryFn: () => api<DeskSettings>('/desk/settings'),
  });
  const now = useNow();
  const mine = myPresence(state, me.user.id);
  // Caller and call info for the ring dialog (page, language, priority).
  const offered = useQuery({
    queryKey: ['call', state.offer?.callId],
    queryFn: () => api<CallDetail>(`/desk/calls/${state.offer!.callId}`),
    enabled: state.offer !== null,
  });

  /** Hold / retrieve the customer; the server starts and stops the music. */
  const toggleHold = async () => {
    if (!active) return;
    try {
      await post(`/desk/calls/${active.callId}/${heldAt ? 'retrieve' : 'hold'}`);
      setHeldAt(heldAt ? null : new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Accept the ringing offer: get a token, subscribe to the transcript, open the panel. */
  const accept = async () => {
    const offer = state.offer;
    if (!offer) return;
    try {
      const joined = await post<{ token: string; url: string }>(
        `/desk/calls/${offer.callId}/accept`,
      );
      send({ type: 'subscribe', callId: offer.callId });
      setActive({ callId: offer.callId, join: { ...joined, publish: true } });
      dispatch({ type: 'offer.clear' });
      setError(null);
    } catch (err) {
      // 409 `not_ringing_you` / `call_over`: the offer moved on or the caller hung up.
      setError(`Could not accept: ${err instanceof Error ? err.message : String(err)}`);
      dispatch({ type: 'offer.clear' });
    }
  };
  const decline = () => {
    if (state.offer) send({ type: 'offer.decline', callId: state.offer.callId });
    dispatch({ type: 'offer.clear' });
  };
  // Hang up: drop the panel first (disconnects the room), then tell the API and go back
  // to Available so the next call can ring. Failures of `/leave` are ignored on purpose.
  const leave = useCallback(async () => {
    if (!active) return;
    const { callId } = active;
    setActive(null);
    setHeldAt(null);
    // The server frees us into wrap-up (or straight to ready) and broadcasts it.
    await post(`/desk/calls/${callId}/leave`, { role: 'human' }).catch(() => undefined);
  }, [active]);

  // Auto-answer: a zip tone, then the offer is accepted without a click.
  const offerId = state.offer?.callId;
  const autoAnswer = settings.data?.autoAnswer ?? false;
  useEffect(() => {
    if (!offerId || active || !autoAnswer) return;
    zipTone();
    const timer = setTimeout(() => void accept(), 600);
    return () => clearTimeout(timer);
  }, [offerId, active, autoAnswer]);

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <StateBar name={me.user.name} me={mine} now={now} onError={setError} />
      </Paper>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {active ? (
        <CallPanel
          join={active.join}
          title="Customer call"
          transcript={state.transcripts[active.callId] ?? []}
          onLeave={() => void leave()}
          extras={<CallNotes callId={active.callId} onError={setError} />}
          hold={{
            heldAt,
            reminderAfterSec: settings.data?.holdReminderSec ?? 0,
            onToggle: () => void toggleHold(),
          }}
        />
      ) : (
        <Typography color="text.secondary">
          {mine?.state === 'ready'
            ? 'Waiting for calls. Keep this tab open to get rung.'
            : 'Set yourself to Ready to receive calls.'}
        </Typography>
      )}
      <Dialog open={state.offer !== null && !active}>
        <DialogTitle>Incoming call · {state.offer?.queueKey}</DialogTitle>
        <DialogContent>
          {offered.data && (
            <Typography gutterBottom color="text.secondary">
              {String(offered.data.customerMeta['page'] ?? '')}
              {offered.data.language ? ` · ${offered.data.language}` : ''}
              {offered.data.priority ? ` · priority ${offered.data.priority}` : ''}
            </Typography>
          )}
          {state.offer?.reason && (
            <Typography gutterBottom>
              <b>Reason:</b> {state.offer.reason}
            </Typography>
          )}
          {state.offer?.summary && (
            <Typography gutterBottom>
              <b>So far:</b> {state.offer.summary}
            </Typography>
          )}
          <Typography color="text.secondary">
            {state.offer ? `${secondsLeft(state.offer, now)}s to answer` : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={decline}>Decline</Button>
          <Button variant="contained" onClick={() => void accept()}>
            Accept
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
