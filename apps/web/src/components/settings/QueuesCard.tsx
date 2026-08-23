/**
 * Settings → Queues: every queue with its routing configuration, hold music, members
 * and a Delete button; plus the form for a new queue. `GET /api/admin/queues`,
 * `POST /api/admin/queues { key, name }` (the key is slugged from the name),
 * `PUT /api/admin/queues/:id/config`, `PUT /api/admin/queues/:id/members { userIds }`
 * (on every checkbox change) and `DELETE /api/admin/queues/:id`, which removes a queue
 * nobody ever called and archives one with call history (hidden, history keeps it).
 */
import {
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Member, type Queue, api, del, post, put } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/useToast.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { SkillsEditor } from './SkillsEditor.tsx';

/** The queue selection algorithms in menu order; their labels are `queues.algorithms.*`. */
const ALGORITHMS = [
  'longest_idle',
  'least_occupied',
  'round_robin',
  'most_skilled',
  'least_skilled',
  'linear',
] as const;

/** The queue's `QueueConfig` as the UI reads it (`{}` means the defaults). */
type Config = {
  algorithm?: string;
  requiredSkills?: { skill: string; min: number }[];
  languageRouting?: boolean;
  moh?: 'calm' | 'bright';
  holdMusicUrl?: string;
};

/**
 * Routing configuration of one queue: selection algorithm, required skills (chips with
 * a minimum level), language routing and hold music. `PUT /api/admin/queues/:id/config`
 * sends every field so nothing silently resets to its default.
 */
function QueueRouting({ queue, onSaved }: { queue: Queue; onSaved: () => void }) {
  const { t, i18n } = useTranslation('settings');
  const toast = useToast();
  const cfg = (queue.config ?? {}) as Config;
  const [algorithm, setAlgorithm] = useState(cfg.algorithm ?? 'longest_idle');
  const [skills, setSkills] = useState(
    (cfg.requiredSkills ?? []).map((r) => ({ skill: r.skill, level: r.min })),
  );
  const [language, setLanguage] = useState(cfg.languageRouting ?? false);
  const [moh, setMoh] = useState<'calm' | 'bright'>(cfg.moh ?? 'calm');
  const [holdMusicUrl, setHoldMusicUrl] = useState(cfg.holdMusicUrl ?? '');
  const save = useMutation({
    mutationFn: () =>
      put(`/admin/queues/${queue.id}/config`, {
        algorithm,
        requiredSkills: skills.map((p) => ({ skill: p.skill, min: p.level })),
        languageRouting: language,
        moh,
        ...(holdMusicUrl.trim() ? { holdMusicUrl: holdMusicUrl.trim() } : {}),
      }),
    onSuccess: () => {
      toast(t('queues.routingSaved', { name: queue.name }));
      onSaved();
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  return (
    <Stack spacing={1.5} sx={{ mb: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <TextField
          select
          size="small"
          label={t('queues.ringOrder')}
          value={algorithm}
          onChange={(e) => setAlgorithm(e.target.value)}
          sx={{ minWidth: 170 }}
        >
          {ALGORITHMS.map((value) => (
            <MenuItem key={value} value={value}>
              {t(`queues.algorithms.${value}`)}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel
          label={t('queues.matchLanguage')}
          control={
            <Checkbox
              size="small"
              checked={language}
              onChange={(e) => setLanguage(e.target.checked)}
            />
          }
        />
        <TextField
          select
          size="small"
          label={t('queues.mohStyle')}
          value={moh}
          onChange={(e) => setMoh(e.target.value as 'calm' | 'bright')}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="calm">{t('queues.moh.calm')}</MenuItem>
          <MenuItem value="bright">{t('queues.moh.bright')}</MenuItem>
        </TextField>
        <TextField
          size="small"
          label={t('queues.holdMusicUrl', { name: queue.name })}
          placeholder={t('queues.holdMusicPlaceholder')}
          value={holdMusicUrl}
          onChange={(e) => setHoldMusicUrl(e.target.value)}
          sx={{ flex: 1, minWidth: 260 }}
        />
      </Stack>
      <SkillsEditor
        label={t('queues.requiredSkills', { name: queue.name })}
        kind="min"
        value={skills}
        onChange={setSkills}
      />
      <div>
        <Button
          size="small"
          variant="outlined"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {t('queues.saveRouting', { name: queue.name })}
        </Button>
      </div>
    </Stack>
  );
}

/** See the module comment. */
export function QueuesCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<Queue[]>('/admin/queues') });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Member[]>('/admin/members'),
  });
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['queues'] });
  const fail = (e: unknown) => toast(errorText(e, i18n), 'error');
  const create = useMutation({
    mutationFn: () => post('/admin/queues', { key: name, name }),
    onSuccess: () => {
      toast(t('queues.added', { name }));
      setName('');
      void refresh();
    },
    onError: fail,
  });
  const setMembers = useMutation({
    mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) =>
      put(`/admin/queues/${id}/members`, { userIds }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (q: Queue) => del<{ archived: boolean }>(`/admin/queues/${q.id}`),
    onSuccess: (result, q) => {
      toast(
        result.archived
          ? t('queues.archived', { name: q.name })
          : t('queues.deleted', { name: q.name }),
      );
      void refresh();
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>
        {t('queues.title')}
      </Typography>
      {(queues.data ?? []).map((q) => (
        <Paper key={q.id} variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <Typography sx={{ flex: 1 }}>
              <b>{q.name}</b>{' '}
              <Typography component="span" color="text.secondary">
                ({q.key})
              </Typography>
            </Typography>
            <ConfirmButton
              size="small"
              color="error"
              aria-label={t('queues.deleteAria', { name: q.name })}
              title={t('queues.deleteTitle', { name: q.name })}
              message={t('queues.deleteMessage')}
              onConfirm={() => remove.mutate(q)}
              disabled={remove.isPending}
            >
              {t('common.delete')}
            </ConfirmButton>
          </Stack>
          <QueueRouting queue={q} onSaved={refresh} />
          <Typography variant="subtitle2">{t('queues.members')}</Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
            {(members.data ?? []).map((m) => (
              <FormControlLabel
                key={m.userId}
                label={m.name}
                control={
                  <Checkbox
                    size="small"
                    checked={q.memberIds.includes(m.userId)}
                    onChange={(e) =>
                      setMembers.mutate({
                        id: q.id,
                        userIds: e.target.checked
                          ? [...q.memberIds, m.userId]
                          : q.memberIds.filter((u) => u !== m.userId),
                      })
                    }
                  />
                }
              />
            ))}
          </Stack>
        </Paper>
      ))}
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          label={t('queues.newQueue')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="contained"
          onClick={() => create.mutate()}
          disabled={!name || create.isPending}
        >
          {t('common.add')}
        </Button>
      </Stack>
    </Paper>
  );
}
