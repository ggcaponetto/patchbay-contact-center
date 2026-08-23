/**
 * Recording buttons shown in the in-call panel: Record starts an Egress recording of the
 * room, Pause / Resume leave a PCI-safe gap between stored segments, Stop ends it. The
 * red REC chip shows the live state; the state itself comes from the server (the desk
 * refetches the call on every `call.updated`), so all desks on the call stay in sync.
 */
import { Button, Chip, Stack } from '@mui/material';
import { post } from '../lib/api.ts';

/** Props of {@link RecordingControls}. */
type Props = {
  callId: string;
  /** Server-side recording state of the call. */
  state: 'off' | 'on' | 'paused';
  /** Reports a failed request (e.g. `recording_unavailable`) to the page. */
  onError?: (message: string) => void;
};

/** See the module comment. */
export function RecordingControls({ callId, state, onError = () => undefined }: Props) {
  const act = async (action: 'start' | 'pause' | 'resume' | 'stop') => {
    try {
      await post(`/desk/calls/${callId}/recording`, { action });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center' }}>
      {state !== 'off' ? (
        <Chip label={state === 'paused' ? 'REC paused' : 'REC'} color="error" size="small" />
      ) : (
        <Button size="small" variant="outlined" color="error" onClick={() => void act('start')}>
          Record
        </Button>
      )}
      {state === 'on' ? (
        <Button size="small" variant="outlined" onClick={() => void act('pause')}>
          Pause recording
        </Button>
      ) : null}
      {state === 'paused' ? (
        <Button size="small" variant="outlined" onClick={() => void act('resume')}>
          Resume recording
        </Button>
      ) : null}
      {state !== 'off' ? (
        <Button size="small" variant="outlined" onClick={() => void act('stop')}>
          Stop recording
        </Button>
      ) : null}
    </Stack>
  );
}
