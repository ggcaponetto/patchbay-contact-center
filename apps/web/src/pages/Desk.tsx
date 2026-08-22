import type { AgentStatus } from '@cc/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useCallback, useState } from 'react';
import { CallPanel, type JoinInfo } from '../components/CallPanel.tsx';
import { type Me, post } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import { secondsLeft } from '../lib/store.ts';

type Props = { desk: ReturnType<typeof useDeskSocket>; me: Me };

/** The agent's workplace: availability toggle, incoming offers, the active call. */
export function Desk({ desk, me }: Props) {
  const { state, dispatch, send, setStatus } = desk;
  const [active, setActive] = useState<{ callId: string; join: JoinInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

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
      setError(`Could not accept: ${err instanceof Error ? err.message : String(err)}`);
      dispatch({ type: 'offer.clear' });
    }
  };
  const decline = () => {
    if (state.offer) send({ type: 'offer.decline', callId: state.offer.callId });
    dispatch({ type: 'offer.clear' });
  };
  const leave = useCallback(async () => {
    if (!active) return;
    const { callId } = active;
    setActive(null);
    await post(`/desk/calls/${callId}/leave`, { role: 'human' }).catch(() => undefined);
    setStatus('available');
  }, [active, setStatus]);

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={2}>
          <Typography>Hi {me.user.name}, you are</Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={state.myStatus}
            onChange={(_e, v: AgentStatus | null) => v && setStatus(v)}
          >
            <ToggleButton value="available" color="success">
              Available
            </ToggleButton>
            <ToggleButton value="away" color="warning">
              Away
            </ToggleButton>
          </ToggleButtonGroup>
          {state.myStatus === 'busy' && <Typography color="text.secondary">(on a call)</Typography>}
        </Stack>
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
        />
      ) : (
        <Typography color="text.secondary">
          {state.myStatus === 'available'
            ? 'Waiting for calls. Keep this tab open to get rung.'
            : 'Set yourself to Available to receive calls.'}
        </Typography>
      )}
      <Dialog open={state.offer !== null && !active}>
        <DialogTitle>Incoming call · {state.offer?.queueKey}</DialogTitle>
        <DialogContent>
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
