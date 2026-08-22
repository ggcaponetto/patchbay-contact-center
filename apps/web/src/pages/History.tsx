import {
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type CallSummary, api } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { useNow } from '../lib/hooks.ts';
import { formatDuration, statusColor, statusLabel } from '../lib/store.ts';

type Props = { desk: ReturnType<typeof useDeskSocket> };

/** Past and current calls of the tenant; click a row for the full conversation. */
export function History({ desk }: Props) {
  const now = useNow();
  const calls = useQuery({
    queryKey: ['calls', desk.state.callsVersion],
    queryFn: () => api<CallSummary[]>('/desk/calls'),
  });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        Calls
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Started</TableCell>
            <TableCell>Queue</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Duration</TableCell>
            <TableCell>Summary</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {(calls.data ?? []).map((c) => (
            <TableRow
              key={c.id}
              hover
              sx={{ cursor: 'pointer' }}
              onClick={() => (location.hash = `#/calls/${c.id}`)}
            >
              <TableCell>{new Date(c.startedAt).toLocaleString()}</TableCell>
              <TableCell>{c.queueKey}</TableCell>
              <TableCell>
                <Chip size="small" color={statusColor[c.status]} label={statusLabel[c.status]} />
              </TableCell>
              <TableCell>{formatDuration(c.startedAt, c.endedAt, now)}</TableCell>
              <TableCell sx={{ maxWidth: 420 }}>{c.aiSummary ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}
