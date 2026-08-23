/**
 * `#/desk`: the page every agent lives on. The {@link StateBar} (Ready / Not ready,
 * wrap-up), the incoming-call dialog with its countdown and, once accepted, the
 * {@link CallPanel} for the active call. State comes from the desk websocket
 * (`desk.state`), every action happens over REST.
 */
import {
  Alert,
  Button,
  Chip,
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
import { useTranslation } from 'react-i18next';
import { CallNotes } from '../components/CallNotes.tsx';
import { CallPanel, type JoinInfo } from '../components/CallPanel.tsx';
import { RecordingControls } from '../components/RecordingControls.tsx';
import { StateBar } from '../components/StateBar.tsx';
import { TransferConsult } from '../components/TransferConsult.tsx';
import { type CallDetail, type DeskSettings, type Me, api, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import { useRingtone, zipTone } from '../lib/sounds.ts';
import { myPresence, secondsLeft } from '../lib/store.ts';

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
  const { t } = useTranslation();
  const { state, dispatch, send } = desk;
  const [active, setActive] = useState<{ callId: string; join: JoinInfo } | null>(null);
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
  // The active call as the server sees it: hold state and who else is on it. Refetched
  // on every call.updated (hold, retrieve, consult accept, drop all bump it).
  const activeDetail = useQuery({
    queryKey: ['call', active?.callId, state.callsVersion],
    queryFn: () => api<CallDetail>(`/desk/calls/${active!.callId}`),
    enabled: active !== null,
  });
  const heldAt = activeDetail.data?.heldAt ?? null;
  // Monitoring notification: a supervisor is on the call (listen / whisper / barge).
  const monitored =
    (settings.data?.monitorNotify ?? true) &&
    (activeDetail.data?.participants ?? []).some(
      (p) => p.kind === 'supervisor' && p.leftAt === null,
    );
  const consultants = (activeDetail.data?.participants ?? [])
    .filter((p) => p.kind === 'human' && p.leftAt === null && p.userId !== me.user.id)
    .map((p) => ({
      userId: p.userId,
      name: state.agents.find((a) => a.userId === p.userId)?.name ?? t('desk.colleague'),
    }));

  /** Hold / retrieve the customer; the server starts and stops the music. */
  const toggleHold = async () => {
    if (!active) return;
    try {
      await post(`/desk/calls/${active.callId}/${heldAt ? 'retrieve' : 'hold'}`);
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
      setError(
        t('desk.couldNotAccept', { error: err instanceof Error ? err.message : String(err) }),
      );
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
  // Otherwise the offer rings (built-in ring or the tenant's ringtone) until answered.
  const ringing = Boolean(offerId) && !active && !autoAnswer;
  useRingtone(ringing, settings.data?.ringtone);

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
          title={t('desk.customerCall')}
          transcript={state.transcripts[active.callId] ?? []}
          onLeave={() => void leave()}
          extras={
            <>
              {monitored ? (
                <Chip
                  size="small"
                  color="warning"
                  label={t('desk.supervisorOnCall')}
                  sx={{ mb: 1 }}
                />
              ) : null}
              <TransferConsult
                callId={active.callId}
                myUserId={me.user.id}
                consultants={consultants}
                onLeft={() => setActive(null)}
                onError={setError}
              />
              <RecordingControls
                callId={active.callId}
                state={activeDetail.data?.recordingState ?? 'off'}
                onError={setError}
              />
              <CallNotes callId={active.callId} onError={setError} />
            </>
          }
          hold={{
            heldAt,
            reminderAfterSec: settings.data?.holdReminderSec ?? 0,
            onToggle: () => void toggleHold(),
          }}
        />
      ) : (
        <Typography color="text.secondary">
          {mine?.state === 'ready' ? t('desk.waitingForCalls') : t('desk.setReady')}
        </Typography>
      )}
      <Dialog
        open={state.offer !== null && !active}
        slotProps={{ paper: { 'data-ringing': ringing || undefined } as object }}
      >
        <DialogTitle>{t('desk.incomingCall', { queue: state.offer?.queueKey })}</DialogTitle>
        <DialogContent>
          {offered.data && (
            <Typography gutterBottom color="text.secondary">
              {String(offered.data.customerMeta['page'] ?? '')}
              {offered.data.language ? ` · ${offered.data.language}` : ''}
              {offered.data.priority
                ? ` · ${t('desk.priority', { priority: offered.data.priority })}`
                : ''}
            </Typography>
          )}
          {state.offer?.reason && (
            <Typography gutterBottom>
              <b>{t('desk.reason')}</b> {state.offer.reason}
            </Typography>
          )}
          {state.offer?.summary && (
            <Typography gutterBottom>
              <b>{t('desk.soFar')}</b> {state.offer.summary}
            </Typography>
          )}
          <Typography color="text.secondary">
            {state.offer
              ? t('desk.secondsToAnswer', { seconds: secondsLeft(state.offer, now) })
              : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={decline}>{t('desk.decline')}</Button>
          <Button variant="contained" onClick={() => void accept()}>
            {t('desk.accept')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
