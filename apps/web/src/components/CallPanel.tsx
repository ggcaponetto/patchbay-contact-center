/**
 * In-call UI shared by the Desk page (agent answering) and the call page (supervisor
 * listening in or taking over). Joins the LiveKit room through `useLiveRoom` and shows
 * the peers, mute/hang-up controls and the transcript.
 */
import type { TranscriptSegmentInput } from '@cc/shared';
import {
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
import { useEffect } from 'react';
import { useLiveRoom } from '../lib/hooks.ts';

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
};

/**
 * The in-call view: who is in the room, mute / hang up, live transcript.
 *
 * Renders a `Paper` with the title, a Connected/Connecting chip, Mute (only when
 * publishing), Hang up / Stop listening, one chip per remote peer (`role: name`), the
 * {@link Transcript} and a hidden container where remote audio elements are attached.
 * No API calls of its own; the parent owns accept/join/leave.
 */
export function CallPanel({ join, title, transcript, onLeave }: Props) {
  const room = useLiveRoom(join);
  // The customer leaving ends the call for us as well: once connected, if no peer carries
  // the `customer` role any more we call `onLeave` so the agent is not stuck in an empty
  // room. `peers` is refreshed on participant connect/disconnect/attribute changes.
  useEffect(() => {
    if (room.connected && !room.peers.some((p) => p.role === 'customer')) onLeave();
  }, [room.connected, room.peers, onLeave]);

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
        {join.publish && (
          <Button variant="outlined" onClick={() => void room.toggleMute()}>
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
