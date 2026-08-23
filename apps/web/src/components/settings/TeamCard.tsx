/**
 * Settings → Team & skills: members with their skills (chip editor, see
 * `SkillsEditor`), pending invites and the invite form. `GET /api/admin/members`,
 * `GET /api/admin/invites`, `POST /api/admin/invites { email, role }` (matched by Google
 * email at sign-in), `GET` / `PUT /api/admin/members/:userId/skills`.
 */
import { Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Invite,
  type Member,
  type Queue,
  type Skill,
  type Tenant,
  api,
  post,
  put,
} from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/useToast.tsx';
import { type SkillLevel, SkillsEditor } from './SkillsEditor.tsx';

/**
 * Skills named anywhere in the tenant — the routing skill catalogue (`settings.skills`)
 * and the queues' requirements — offered as suggestions by every skills editor.
 */
export function useSkillSuggestions(): string[] {
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/admin/tenant') });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<Queue[]>('/admin/queues') });
  return [
    ...new Set([
      ...(tenant.data?.settings.skills ?? []).map((s) => s.key),
      ...(queues.data ?? []).flatMap((q) =>
        ((q.config.requiredSkills as { skill: string }[] | undefined) ?? []).map((r) => r.skill),
      ),
    ]),
  ];
}

/** Skills of one member; Save replaces the list and confirms with a toast. */
function MemberSkills({ member, suggestions }: { member: Member; suggestions: string[] }) {
  const { t, i18n } = useTranslation('settings');
  const toast = useToast();
  const skills = useQuery({
    queryKey: ['skills', member.userId],
    queryFn: () => api<Skill[]>(`/admin/members/${member.userId}/skills`),
  });
  const [draft, setDraft] = useState<SkillLevel[] | null>(null);
  const value = draft ?? (skills.data ?? []).map((s) => ({ skill: s.skill, level: s.proficiency }));
  const save = useMutation({
    mutationFn: () =>
      put(`/admin/members/${member.userId}/skills`, {
        skills: value.map((p) => ({ skill: p.skill, proficiency: p.level })),
      }),
    onSuccess: () => {
      toast(t('team.skillsSaved', { name: member.name }));
      setDraft(null);
      void skills.refetch();
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <SkillsEditor
        label={t('team.addSkill', { name: member.name })}
        value={value}
        onChange={setDraft}
        suggestions={suggestions}
      />
      <div>
        <Button
          size="small"
          variant="outlined"
          onClick={() => save.mutate()}
          disabled={draft === null || save.isPending}
        >
          {t('team.saveSkills', { name: member.name })}
        </Button>
      </div>
    </Stack>
  );
}

/** See the module comment. */
export function TeamCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Member[]>('/admin/members'),
  });
  const invites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api<Invite[]>('/admin/invites'),
  });
  const suggestions = useSkillSuggestions();
  const roleName = (role: string) =>
    role === 'supervisor' ? t('team.roles.supervisor') : t('team.roles.agent');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'agent' | 'supervisor'>('agent');
  const invite = useMutation({
    mutationFn: () => post('/admin/invites', { email, role }),
    onSuccess: () => {
      toast(t('team.invited', { email }));
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" component="h2" gutterBottom>
        {t('team.title')}
      </Typography>
      <Stack spacing={2} sx={{ mb: 2 }}>
        {(members.data ?? []).map((m) => (
          <Paper key={m.userId} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography>{m.name}</Typography>
              <Typography color="text.secondary">{m.email}</Typography>
              <Chip size="small" label={roleName(m.role)} />
            </Stack>
            <MemberSkills member={m} suggestions={suggestions} />
          </Paper>
        ))}
        {(invites.data ?? [])
          .filter((i) => !i.acceptedAt)
          .map((i) => (
            <Stack key={i.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography color="text.secondary">{i.email}</Typography>
              <Chip
                size="small"
                variant="outlined"
                label={t('team.invitedAs', { role: roleName(i.role) })}
              />
            </Stack>
          ))}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <TextField
          size="small"
          label={t('team.inviteLabel')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          sx={{ flex: 1 }}
        />
        <TextField
          select
          size="small"
          value={role}
          onChange={(e) => setRole(e.target.value as 'agent' | 'supervisor')}
        >
          <MenuItem value="agent">{t('team.roles.agent')}</MenuItem>
          <MenuItem value="supervisor">{t('team.roles.supervisor')}</MenuItem>
        </TextField>
        <Button
          variant="contained"
          onClick={() => invite.mutate()}
          disabled={!email || invite.isPending}
        >
          {t('team.invite')}
        </Button>
      </Stack>
    </Paper>
  );
}
