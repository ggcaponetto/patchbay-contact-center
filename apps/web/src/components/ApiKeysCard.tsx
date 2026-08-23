/**
 * Settings card for API keys (machine access to the public API with an explicit
 * permission set). `GET/POST /api/admin/api-keys`, `POST /api/admin/api-keys/:id/revoke`
 * (the row stays, marked revoked) and `DELETE /api/admin/api-keys/:id` (gone for good).
 * The secret is shown exactly once, right after creation — the API only stores a hash.
 */
import { Permission } from '@cc/shared';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ApiKey, api, del, post } from '../lib/api.ts';
import { errorText, useToast } from '../lib/useToast.tsx';
import { ConfirmButton } from './ConfirmButton.tsx';

/** See the module comment. */
export function ApiKeysCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
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
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => post(`/admin/api-keys/${id}/revoke`, {}),
    onSuccess: () => {
      toast(t('apiKeys.keyRevoked'));
      void refresh();
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/api-keys/${id}`),
    onSuccess: () => {
      toast(t('apiKeys.keyDeleted'));
      void refresh();
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  const toggle = (p: string, on: boolean) =>
    setPermissions(on ? [...permissions, p] : permissions.filter((x) => x !== p));

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        {t('apiKeys.title')}
      </Typography>
      {secret && (
        <Alert severity="success" onClose={() => setSecret(null)} sx={{ mb: 2 }}>
          {t('apiKeys.copyNow')}{' '}
          <TextField
            size="small"
            fullWidth
            value={secret}
            slotProps={{
              input: { readOnly: true },
              htmlInput: { 'aria-label': t('apiKeys.newKey') },
            }}
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
            <Chip size="small" label={t('apiKeys.revoked')} />
          ) : (
            <Button
              size="small"
              aria-label={t('apiKeys.revokeAria', { name: k.name })}
              onClick={() => revoke.mutate(k.id)}
            >
              {t('apiKeys.revoke')}
            </Button>
          )}
          <ConfirmButton
            size="small"
            color="error"
            aria-label={t('apiKeys.deleteAria', { name: k.name })}
            title={t('apiKeys.deleteTitle', { name: k.name })}
            message={t('apiKeys.deleteMessage')}
            onConfirm={() => remove.mutate(k.id)}
          >
            {t('common.delete')}
          </ConfirmButton>
        </Stack>
      ))}
      <Stack spacing={1} sx={{ mt: 2 }}>
        <TextField
          size="small"
          label={t('apiKeys.name')}
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
          {t('apiKeys.create')}
        </Button>
      </Stack>
    </Paper>
  );
}
