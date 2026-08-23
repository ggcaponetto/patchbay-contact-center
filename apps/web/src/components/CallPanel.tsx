/**
 * In-call UI shared by the Desk page (agent answering) and the call page (supervisor
 * listening in or taking over). Joins the LiveKit room through `useLiveRoom` and shows
 * the peers, mute/hang-up controls and the transcript.
 */
import type { TranscriptSegmentInput } from '@cc/shared';
import {
  Alert,
  Box,
  Button,
  Chip,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { type ReactNode, useEffect, useState } from 'react';
import { useLiveRoom, useNow } from '../lib/hooks.ts';

/**
 * What is needed to enter a call's LiveKit room: the `token` and `url` returned by
 * `POST /api/desk/calls/:id/accept` or `/join`, plus whether to publish the microphone
 * (`false` for a supervisor listening in).
 */
export type JoinInfo = { token: string; url: string; publish: boolean };

/** Props of {@link CallPanel}. */
type Props = {
  /** Room credentials; keep the object stable, a new one reconnects. */
  join: JoinInfo;
  /** Heading, e.g. "Customer call" or "Listening in". */
  title: string;
  /** Segments to list, usually `desk.state.transcripts[callId]` (merged with stored rows on the call page). */
  transcript: TranscriptSegmentInput[];
  /** Called on Hang up / Stop listening and when the customer leaves; the parent posts `/leave`. */
  onLeave: () => void;
  /** Extra controls below the peers (notes, tags, hold — the parent decides). */
  extras?: ReactNode;
  /**
   * Hold state owned by the parent (`POST /calls/:id/hold` / `/retrieve`); the panel
   * shows the button + timer and applies the local audio side (mute + unsubscribe).
   */
  hold?: { heldAt: string | null; onToggle: () => void; reminderAfterSec: number };
};

/**
 * The in-call view: who is in the room, mute / hang up, live transcript.
 *
 * Renders a `Paper` with the title, a Connected/Connecting chip, Mute (only when
 * publishing), Hang up / Stop listening, one chip per remote peer (`role: name`), the
 * {@link Transcript} and a hidden container where remote audio elements are attached.
 * No API calls of its own; the parent owns accept/join/leave.
 */
export function CallPanel({ join, title, transcript, onLeave, extras, hold }: Props) {
  const room = useLiveRoom(join);
  const now = useNow();
  const heldFor = hold?.heldAt ? Math.floor((now - Date.parse(hold.heldAt)) / 1000) : 0;
  // The audio side of hold follows the server state the parent passes down.
  const held = Boolean(hold?.heldAt);
  useEffect(() => {
    if (room.connected) void room.setHeld(held);
  }, [held, room.connected]);
  const [sawCustomer, setSawCustomer] = useState(false);
  const [wasConnected, setWasConnected] = useState(false);
  // Dropped from the room (consult drop, room deleted): fold the panel via onLeave —
  // the server already recorded whatever happened, the extra /leave is harmless.
  useEffect(() => {
    if (room.connected) setWasConnected(true);
    else if (wasConnected) onLeave();
  }, [room.connected, wasConnected, onLeave]);
  // The customer leaving ends the call for us as well: once connected, if no peer carries
  // the `customer` role any more we call `onLeave` so the agent is not stuck in an empty
  // room. `peers` is refreshed on participant connect/disconnect/attribute changes.
  useEffect(() => {
    const customerHere = room.peers.some((p) => p.role === 'customer');
    if (customerHere) setSawCustomer(true);
    // Only a customer who was here and left ends the call — never a room that is still
    // filling up right after the join.
    if (room.connected && sawCustomer && !customerHere) onLeave();
  }, [room.connected, room.peers, sawCustomer, onLeave]);

  return (
    <Paper sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'center' }}>
        <Typography variant="h6">{title}</Typography>
        <Chip
          size="small"
          color={room.connected ? 'success' : 'default'}
          label={room.connected ? 'Connected' : 'Connecting…'}
        />
        <Box sx={{ flex: 1 }} />
        {join.publish && hold && (
          <Button variant="outlined" color={held ? 'warning' : 'primary'} onClick={hold.onToggle}>
            {held
              ? `Retrieve (${Math.floor(heldFor / 60)}:${String(heldFor % 60).padStart(2, '0')})`
              : 'Hold'}
          </Button>
        )}
        {join.publish && (
          <Button variant="outlined" onClick={() => void room.toggleMute()} disabled={held}>
            {room.muted ? 'Unmute' : 'Mute'}
          </Button>
        )}
        <Button variant="contained" color="error" onClick={onLeave}>
          {join.publish ? 'Hang up' : 'Stop listening'}
        </Button>
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        {room.peers.map((p) => (
          <Chip key={p.identity} label={`${p.role}${p.name ? `: ${p.name}` : ''}`} />
        ))}
      </Stack>
      {held && hold && hold.reminderAfterSec > 0 && heldFor >= hold.reminderAfterSec && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The customer has been on hold for {heldFor} seconds.
        </Alert>
      )}
      {extras}
      <Transcript segments={transcript} />
      <div ref={room.audioRef} />
    </Paper>
  );
}

/**
 * Dense scrollable list of transcript segments (text + speaker role). Shows a
 * placeholder when empty. Index keys are fine: segments are append-only.
 */
export function Transcript({ segments }: { segments: TranscriptSegmentInput[] }) {
  return (
    <List dense sx={{ maxHeight: 360, overflow: 'auto', bgcolor: 'action.hover', borderRadius: 1 }}>
      {segments.length === 0 && (
        <ListItem>
          <ListItemText secondary="No transcript yet." />
        </ListItem>
      )}
      {segments.map((s, i) => (
        <ListItem key={i}>
          <ListItemText primary={s.text} secondary={s.speaker} />
        </ListItem>
      ))}
    </List>
  );
}
