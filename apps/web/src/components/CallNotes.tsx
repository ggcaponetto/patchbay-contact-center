/**
 * In-call annotations: free-form notes (appended to the call's timeline) and tags
 * (categorization, replaced as a set). Rendered inside the {@link CallPanel} while on a
 * call and on the call page afterwards.
 */
import { Button, Stack, TextField } from '@mui/material';
import { useState } from 'react';
import { post } from '../lib/api.ts';

/** Props of {@link CallNotes}. */
type Props = {
  callId: string;
  /** Current tags of the call (prefills the tags field). */
  tags?: string[];
  /** Reports a failed request to the page. */
  onError?: (message: string) => void;
};

/** See the module comment. */
export function CallNotes({ callId, tags = [], onError = () => undefined }: Props) {
  const [note, setNote] = useState('');
  const [tagText, setTagText] = useState(tags.join(', '));
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  const addNote = async () => {
    const text = note.trim();
    if (!text) return;
    await run(() => post(`/desk/calls/${callId}/note`, { text }));
    setNote('');
  };
  const saveTags = () =>
    run(() =>
      post(`/desk/calls/${callId}/tags`, {
        tags: tagText
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    );

  return (
    <Stack spacing={1} sx={{ mt: 2 }}>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button variant="outlined" onClick={() => void addNote()} disabled={!note.trim()}>
          Add note
        </Button>
      </Stack>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label="Tags (comma separated)"
          value={tagText}
          onChange={(e) => setTagText(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button variant="outlined" onClick={() => void saveTags()}>
          Save tags
        </Button>
      </Stack>
    </Stack>
  );
}
