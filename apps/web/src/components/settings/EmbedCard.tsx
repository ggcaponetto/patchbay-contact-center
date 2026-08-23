/**
 * Settings → Call button: embed keys for the website call button.
 * `GET/POST/DELETE /api/admin/embed-keys`. For each key a ready-to-paste snippet is
 * shown; it uses the desk's own origin as the API origin, which is right in dev (Vite
 * proxies `/api` and `/embed`) and whenever the desk is served by the API.
 */
import { Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type EmbedKey, type Queue, api, del, post } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/useToast.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';

/** See the module comment. */
export function EmbedCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useQuery({
    queryKey: ['embedKeys'],
    queryFn: () => api<EmbedKey[]>('/admin/embed-keys'),
  });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<Queue[]>('/admin/queues') });
  const [label, setLabel] = useState('');
  const [origins, setOrigins] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['embedKeys'] });
  const fail = (e: unknown) => toast(errorText(e, i18n), 'error');
  const create = useMutation({
    mutationFn: () =>
      post('/admin/embed-keys', {
        label,
        allowedOrigins: origins.split(/[\s,]+/).filter(Boolean),
      }),
    onSuccess: () => {
      toast(t('embed.created', { label }));
      setLabel('');
      setOrigins('');
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/embed-keys/${id}`),
    onSuccess: () => {
      toast(t('embed.deleted'));
      void refresh();
    },
    onError: fail,
  });
  const apiOrigin = location.origin;
  const queueKey = queues.data?.[0]?.key ?? 'support';
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        {t('embed.title')}
      </Typography>
      {(keys.data ?? []).map((k) => (
        <Paper key={k.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
          <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
            <Typography sx={{ flex: 1 }}>
              <b>{k.label}</b>{' '}
              <Typography component="span" color="text.secondary">
                {k.allowedOrigins.length ? k.allowedOrigins.join(', ') : t('embed.anyOrigin')}
              </Typography>
            </Typography>
            <ConfirmButton
              icon
              size="small"
              aria-label={t('embed.deleteAria', { label: k.label })}
              title={t('embed.deleteTitle', { label: k.label })}
              message={t('embed.deleteMessage')}
              onConfirm={() => remove.mutate(k.id)}
            >
              ✕
            </ConfirmButton>
          </Stack>
          <TextField
            fullWidth
            size="small"
            multiline
            label={t('embed.snippet')}
            slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12 } } }}
            value={`<script src="${apiOrigin}/embed/call-button.js"></script>\n<cc-call-button key="${k.publicKey}" queue="${queueKey}" api="${apiOrigin}" label="Call us"></cc-call-button>`}
            sx={{ mt: 1 }}
          />
        </Paper>
      ))}
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label={t('embed.label')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          size="small"
          label={t('embed.origins')}
          placeholder={t('embed.originsPlaceholder')}
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button
          variant="contained"
          onClick={() => create.mutate()}
          disabled={!label || create.isPending}
        >
          {t('embed.create')}
        </Button>
      </Stack>
    </Paper>
  );
}
