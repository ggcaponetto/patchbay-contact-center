/**
 * Settings card for API keys (machine access to the public API with an explicit
 * permission set). `GET/POST/DELETE /api/admin/api-keys`. The secret is shown exactly
 * once, right after creation — the API only stores a hash.
 */
import { Permission } from '@cc/shared';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ApiKey, api, del, post } from '../lib/api.ts';

/** See the module comment. */
export function ApiKeysCard() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['apiKeys'], queryFn: () => api<ApiKey[]>('/admin/api-keys') });
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<string[]>(['calls:read']);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['apiKeys'] });
  const create = useMutation({
    mutationFn: () => post<ApiKey & { secret: string }>('/admin/api-keys', { name, permissions }),
    onSuccess: (created) => {
      setSecret(created.secret);
      setName('');
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/admin/api-keys/${id}`),
    onSuccess: refresh,
  });
  const toggle = (p: string, on: boolean) =>
    setPermissions(on ? [...permissions, p] : permissions.filter((x) => x !== p));

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        API keys
      </Typography>
      {secret && (
        <Alert severity="success" onClose={() => setSecret(null)} sx={{ mb: 2 }}>
          Copy the key now, it will not be shown again:{' '}
          <TextField
            size="small"
            fullWidth
            value={secret}
            slotProps={{ input: { readOnly: true }, htmlInput: { 'aria-label': 'New API key' } }}
            sx={{ mt: 1 }}
          />
        </Alert>
      )}
      {(keys.data ?? []).map((k) => (
        <Stack key={k.id} direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography sx={{ flex: 1 }}>
            <b>{k.name}</b>{' '}
            <Typography component="span" color="text.secondary">
              {k.prefix}… · {k.permissions.join(', ')}
            </Typography>
          </Typography>
          {k.revokedAt ? (
            <Chip size="small" label="revoked" />
          ) : (
            <IconButton
              size="small"
              aria-label={`revoke ${k.name}`}
              onClick={() => revoke.mutate(k.id)}
            >
              ✕
            </IconButton>
          )}
        </Stack>
      ))}
      <Stack spacing={1} sx={{ mt: 2 }}>
        <TextField
          size="small"
          label="Key name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
          {Permission.options.map((p) => (
            <FormControlLabel
              key={p}
              label={p}
              control={
                <Checkbox
                  size="small"
                  checked={permissions.includes(p)}
                  onChange={(e) => toggle(p, e.target.checked)}
                />
              }
            />
          ))}
        </Stack>
        <Button
          variant="contained"
          onClick={() => create.mutate()}
          disabled={!name || permissions.length === 0}
        >
          Create API key
        </Button>
      </Stack>
    </Paper>
  );
}
