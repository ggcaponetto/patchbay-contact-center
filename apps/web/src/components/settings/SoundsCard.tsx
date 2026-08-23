/**
 * Settings → Sounds: the tenant's hold music, desk ringtone and customer ringback, each
 * either a public URL or a file uploaded here (stored by the API, served from
 * `/api/public/media/:id`). Hold music must be WAV (the media worker decodes it);
 * browser-played sounds can be any audio format. Empty means the built-in sound
 * (synthesized hold music and ringtone, no ringback). Save sends
 * `PATCH /api/admin/tenant/settings { sounds }`; uploads go to
 * `POST /api/admin/media-assets` and the list below lets you reuse or delete them.
 */
import type { MediaAsset, Sounds } from '@cc/shared';
import { Button, Chip, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Tenant, api, del, patch, uploadMediaAsset } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/useToast.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';

/**
 * The three configurable sounds, in display order; their label, lower-case name and
 * hint are the `sounds.labels.*`, `sounds.names.*` and `sounds.hints.*` keys.
 */
const SOUNDS: { key: keyof Sounds; accept: string }[] = [
  { key: 'holdMusic', accept: 'audio/wav,.wav' },
  { key: 'ringtone', accept: 'audio/*' },
  { key: 'ringback', accept: 'audio/*' },
];

/** Human file size. */
function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} kB`;
}

/** See the module comment. */
export function SoundsCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/admin/tenant') });
  const assets = useQuery({
    queryKey: ['media-assets'],
    queryFn: () => api<MediaAsset[]>('/admin/media-assets'),
  });
  const [draft, setDraft] = useState<Sounds | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (tenant.data) setDraft(tenant.data.settings.sounds);
  }, [tenant.data]);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  const fail = (e: unknown) => toast(errorText(e, i18n), 'error');
  const save = useMutation({
    mutationFn: (sounds: Sounds) => patch('/admin/tenant/settings', { sounds }),
    onSuccess: () => {
      toast(t('sounds.saved'));
      void qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: fail,
  });
  const upload = useMutation({
    mutationFn: ({ file }: { key: keyof Sounds; file: File }) => uploadMediaAsset(file),
    onSuccess: (asset, { key }) => {
      toast(t('sounds.uploaded', { name: asset.name }));
      setDraft((d) => ({ ...(d ?? {}), [key]: asset.url }));
      void qc.invalidateQueries({ queryKey: ['media-assets'] });
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/media-assets/${id}`),
    onSuccess: () => {
      toast(t('sounds.fileDeleted'));
      void qc.invalidateQueries({ queryKey: ['media-assets'] });
    },
    onError: fail,
  });
  const play = (url: string) => {
    if (playing === url) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const el = new Audio(url);
    el.onended = () => setPlaying(null);
    audio.current = el;
    setPlaying(url);
    el.play().catch(() => {
      toast(t('sounds.cannotPlay'), 'error');
      setPlaying(null);
    });
  };
  if (!draft) return null;
  const set = (key: keyof Sounds, value: string) =>
    setDraft({ ...draft, [key]: value.trim() || undefined });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        {t('sounds.title')}
      </Typography>
      <Stack spacing={2}>
        {SOUNDS.map((s) => {
          const value = draft[s.key] ?? '';
          return (
            <Stack key={s.key} spacing={0.5}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <TextField
                  size="small"
                  label={t('sounds.url', { label: t(`sounds.labels.${s.key}`) })}
                  placeholder={t('sounds.urlPlaceholder')}
                  value={value}
                  onChange={(e) => set(s.key, e.target.value)}
                  sx={{ flex: 1, minWidth: 280 }}
                />
                <Button size="small" component="label" disabled={upload.isPending}>
                  {t('sounds.upload')}
                  <input
                    hidden
                    type="file"
                    accept={s.accept}
                    aria-label={t('sounds.uploadAria', { sound: t(`sounds.names.${s.key}`) })}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) upload.mutate({ key: s.key, file });
                      e.target.value = '';
                    }}
                  />
                </Button>
                <Button size="small" disabled={!value} onClick={() => play(value)}>
                  {playing === value ? t('sounds.stop') : t('sounds.play')}
                </Button>
                <Button size="small" disabled={!value} onClick={() => set(s.key, '')}>
                  {t('sounds.clear')}
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {t(`sounds.hints.${s.key}`)}
              </Typography>
            </Stack>
          );
        })}
        <div>
          <Button variant="contained" onClick={() => save.mutate(draft)} disabled={save.isPending}>
            {t('sounds.save')}
          </Button>
        </div>
      </Stack>
      {(assets.data?.length ?? 0) > 0 && (
        <>
          <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
            {t('sounds.uploadedFiles')}
          </Typography>
          <Stack spacing={1}>
            {assets.data!.map((a) => (
              <Stack
                key={a.id}
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Typography sx={{ minWidth: 160 }}>{a.name}</Typography>
                <Chip size="small" label={a.mimeType} />
                <Typography variant="body2" color="text.secondary">
                  {size(a.sizeBytes)}
                </Typography>
                {SOUNDS.map((s) => (
                  <Button
                    key={s.key}
                    size="small"
                    disabled={s.key === 'holdMusic' && !/wav/i.test(a.mimeType)}
                    onClick={() => set(s.key, a.url)}
                  >
                    {t('sounds.useAs', { sound: t(`sounds.names.${s.key}`) })}
                  </Button>
                ))}
                <ConfirmButton
                  size="small"
                  color="error"
                  aria-label={t('sounds.deleteAria', { name: a.name })}
                  title={t('sounds.deleteTitle', { name: a.name })}
                  message={t('sounds.deleteMessage')}
                  onConfirm={() => remove.mutate(a.id)}
                >
                  {t('common.delete')}
                </ConfirmButton>
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Paper>
  );
}
