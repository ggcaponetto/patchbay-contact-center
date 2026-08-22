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

export type JoinInfo = { token: string; url: string; publish: boolean };

type Props = {
  join: JoinInfo;
  title: string;
  transcript: TranscriptSegmentInput[];
  onLeave: () => void;
};

/** The in-call view: who is in the room, mute / hang up, live transcript. */
export function CallPanel({ join, title, transcript, onLeave }: Props) {
  const room = useLiveRoom(join);
  // The customer leaving ends the call for us as well.
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
