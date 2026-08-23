/**
 * Settings → Business hours: mode (always open, weekly schedule, or forced open /
 * closed / emergency), timezone, weekly windows, holidays and the messages shown to
 * callers while closed. Save sends `PATCH /api/admin/tenant/settings { hours }` only.
 */
import { type TenantSettings } from '@cc/shared';
import { Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Tenant, api, patch } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/useToast.tsx';

/** Day names in `dow` order (0 = Sunday), for the business-hours window lines. */
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parses `mon 09:00-17:00` lines into weekly windows; malformed lines are dropped. */
export function parseWindows(text: string): { dow: number; from: string; to: string }[] {
  return text
    .split('\n')
    .map((line) => /^\s*(\w{3})\w*\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ dow: DAYS.indexOf(m[1]!.toLowerCase()), from: m[2]!, to: m[3]! }))
    .filter((w) => w.dow >= 0);
}

/** See the module comment. */
export function HoursCard() {
  const { t, i18n } = useTranslation('settings');
  const qc = useQueryClient();
  const toast = useToast();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/admin/tenant') });
  const [draft, setDraft] = useState<TenantSettings['hours'] | null>(null);
  const [windows, setWindows] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (hours: TenantSettings['hours']) => patch('/admin/tenant/settings', { hours }),
    onSuccess: () => {
      toast(t('hours.saved'));
      void qc.invalidateQueries({ queryKey: ['tenant'] });
    },
    onError: (e) => toast(errorText(e, i18n), 'error'),
  });
  if (!tenant.data) return null;
  const hours = draft ?? tenant.data.settings.hours;
  const windowsText =
    windows ?? hours.open.map((w) => `${DAYS[w.dow]} ${w.from}-${w.to}`).join('\n');
  const holidaysText = holidays ?? hours.holidays.join('\n');
  const set = (patchPart: Partial<TenantSettings['hours']>) => setDraft({ ...hours, ...patchPart });
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" component="h2" gutterBottom>
        {t('hours.title')}
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 2 }}>
        <TextField
          select
          label={t('hours.mode')}
          value={hours.mode}
          onChange={(e) => set({ mode: e.target.value as TenantSettings['hours']['mode'] })}
          sx={{ minWidth: { xs: '100%', sm: 190 } }}
        >
          {(['off', 'auto', 'open', 'closed', 'emergency'] as const).map((m) => (
            <MenuItem key={m} value={m}>
              {t(`hours.modes.${m}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label={t('hours.timezone')}
          value={hours.timezone}
          onChange={(e) => set({ timezone: e.target.value })}
        />
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 2 }}>
        <TextField
          label={t('hours.windows')}
          multiline
          minRows={3}
          value={windowsText}
          onChange={(e) => {
            setWindows(e.target.value);
            set({ open: parseWindows(e.target.value) });
          }}
          sx={{ flex: 1, minWidth: { xs: '100%', sm: 260 } }}
        />
        <TextField
          label={t('hours.holidays')}
          multiline
          minRows={3}
          value={holidaysText}
          onChange={(e) => {
            setHolidays(e.target.value);
            set({
              holidays: e.target.value
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l)),
            });
          }}
          sx={{ flex: 1, minWidth: { xs: '100%', sm: 260 } }}
        />
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 2 }}>
        <TextField
          label={t('hours.closedMessage')}
          value={hours.closedMessage}
          onChange={(e) => set({ closedMessage: e.target.value })}
          sx={{ flex: 1, minWidth: { xs: '100%', sm: 260 } }}
        />
        <TextField
          label={t('hours.emergencyMessage')}
          value={hours.emergencyMessage}
          onChange={(e) => set({ emergencyMessage: e.target.value })}
          sx={{ flex: 1, minWidth: { xs: '100%', sm: 260 } }}
        />
      </Stack>
      <Button variant="contained" onClick={() => save.mutate(hours)} disabled={save.isPending}>
        {t('hours.save')}
      </Button>
    </Paper>
  );
}
