/**
 * Settings → Routing & AI: who answers first, handoff behavior, timeouts, dashboard
 * alerts, agent options, wrap-up codes, the routing skill catalogue and the AI prompt. `GET /api/admin/tenant` seeds
 * a local draft; Save sends only this card's keys with `PATCH /api/admin/tenant/settings`
 * (the hours and sounds cards own theirs) and invalidates `['tenant']`.
 */
import { type TenantSettings } from '@cc/shared';
import {
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  Grid,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Tenant, api, patch } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/useToast.tsx';
import { CodesEditor } from './CodesEditor.tsx';
import { SkillCatalogEditor } from './SkillCatalogEditor.tsx';

/** The settings keys this card owns (and sends); the rest belong to other cards. */
const OWN_KEYS = [
  'routingMode',
  'handoff',
  'offerTimeoutSec',
  'humanFirstTimeoutSec',
  'acwSec',
  'holdReminderSec',
  'alerts',
  'dispositions',
  'dispositionRequired',
  'autoAnswer',
  'monitorNotify',
  'notReadyReasons',
  'aiAgent',
  'skills',
] as const;

/** The subset of {@link TenantSettings} edited here. */
export type RoutingSettings = Pick<TenantSettings, (typeof OWN_KEYS)[number]>;

/** Picks this card's keys out of the full settings. */
export function routingSettings(s: TenantSettings): RoutingSettings {
  return Object.fromEntries(OWN_KEYS.map((k) => [k, s[k]])) as RoutingSettings;
}

/** A section title inside the card. */
function Section({ title }: { title: string }) {
  return (
    <Typography variant="subtitle2" sx={{ mt: 1 }}>
      {title}
    </Typography>
  );
}

/** See the module comment. */
export function RoutingCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/admin/tenant') });
  const [draft, setDraft] = useState<RoutingSettings | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (tenant.data) setDraft(routingSettings(tenant.data.settings));
  }, [tenant.data]);
  const save = useMutation({
    mutationFn: (s: RoutingSettings) => patch('/admin/tenant/settings', s),
    onSuccess: () => {
      toast(t('routing.saved'));
      void qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  if (!draft) return null;
  const num = (key: keyof RoutingSettings, label: string) => (
    <TextField
      type="number"
      label={label}
      value={draft[key]}
      onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
      sx={{ width: { xs: '100%', sm: 200 } }}
    />
  );
  const addReason = () => {
    const r = reason.trim();
    if (r && !draft.notReadyReasons.includes(r))
      setDraft({ ...draft, notReadyReasons: [...draft.notReadyReasons, r] });
    setReason('');
  };
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" component="h2" gutterBottom>
        {t('routing.title')}
      </Typography>
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Stack spacing={2}>
            <Section title={t('routing.sections.routing')} />
            <TextField
              select
              label={t('routing.mode.label')}
              value={draft.routingMode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  routingMode: e.target.value as TenantSettings['routingMode'],
                })
              }
            >
              <MenuItem value="ai-first">{t('routing.mode.aiFirst')}</MenuItem>
              <MenuItem value="human-first">{t('routing.mode.humanFirst')}</MenuItem>
            </TextField>
            <TextField
              select
              label={t('routing.handoff.label')}
              value={draft.handoff.aiBehavior}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  handoff: {
                    aiBehavior: e.target.value as TenantSettings['handoff']['aiBehavior'],
                  },
                })
              }
            >
              <MenuItem value="leave">{t('routing.handoff.leave')}</MenuItem>
              <MenuItem value="listen">{t('routing.handoff.listen')}</MenuItem>
            </TextField>
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
              {num('offerTimeoutSec', t('routing.offerTimeout'))}
              {num('humanFirstTimeoutSec', t('routing.humanFirstTimeout'))}
              {num('holdReminderSec', t('routing.holdReminder'))}
            </Stack>
            <Section title={t('routing.sections.alerts')} />
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 2 }}>
              {(['maxWaiting', 'maxWaitSec', 'maxCallSec'] as const).map((k) => (
                <TextField
                  key={k}
                  type="number"
                  label={t(`routing.alerts.${k}`)}
                  value={draft.alerts[k]}
                  onChange={(e) =>
                    setDraft({ ...draft, alerts: { ...draft.alerts, [k]: Number(e.target.value) } })
                  }
                  sx={{ width: { xs: '100%', sm: 200 } }}
                />
              ))}
            </Stack>
            <Section title={t('routing.sections.agents')} />
            <FormControlLabel
              label={t('routing.autoAnswer')}
              control={
                <Checkbox
                  checked={draft.autoAnswer}
                  onChange={(e) => setDraft({ ...draft, autoAnswer: e.target.checked })}
                />
              }
            />
            <FormControlLabel
              label={t('routing.monitorNotify')}
              control={
                <Checkbox
                  checked={draft.monitorNotify}
                  onChange={(e) => setDraft({ ...draft, monitorNotify: e.target.checked })}
                />
              }
            />
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              {draft.notReadyReasons.map((r) => (
                <Chip
                  key={r}
                  label={r}
                  size="small"
                  onDelete={() =>
                    setDraft({
                      ...draft,
                      notReadyReasons: draft.notReadyReasons.filter((x) => x !== r),
                    })
                  }
                />
              ))}
            </Stack>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                label={t('routing.notReadyReasons')}
                placeholder={t('routing.notReadyPlaceholder')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addReason();
                  }
                }}
                sx={{ flex: 1 }}
              />
              <Button size="small" onClick={addReason} disabled={!reason.trim()}>
                {t('common.add')}
              </Button>
            </Stack>
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <Stack spacing={2}>
            <Section title={t('routing.sections.wrapUp')} />
            {num('acwSec', t('routing.acw'))}
            <CodesEditor
              value={draft.dispositions}
              onChange={(dispositions) => setDraft({ ...draft, dispositions })}
            />
            <FormControlLabel
              label={t('routing.dispositionRequired')}
              control={
                <Checkbox
                  checked={draft.dispositionRequired}
                  onChange={(e) => setDraft({ ...draft, dispositionRequired: e.target.checked })}
                />
              }
            />
            <Section title={t('routing.skillsTitle')} />
            <Typography variant="body2" color="text.secondary">
              {t('routing.skillsHint')}
            </Typography>
            <SkillCatalogEditor
              value={draft.skills}
              onChange={(skills) => setDraft({ ...draft, skills })}
            />
            <Section title={t('routing.sections.aiAgent')} />
            <TextField
              label={t('routing.greeting')}
              value={draft.aiAgent.greeting}
              onChange={(e) =>
                setDraft({ ...draft, aiAgent: { ...draft.aiAgent, greeting: e.target.value } })
              }
            />
            <TextField
              label={t('routing.instructions')}
              multiline
              minRows={6}
              placeholder={t('routing.instructionsPlaceholder')}
              value={draft.aiAgent.instructions}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  aiAgent: { ...draft.aiAgent, instructions: e.target.value },
                })
              }
            />
          </Stack>
        </Grid>
      </Grid>
      <Button
        variant="contained"
        onClick={() => save.mutate(draft)}
        disabled={save.isPending}
        sx={{ mt: 2 }}
      >
        {t('common.save')}
      </Button>
    </Paper>
  );
}
