/**
 * List editor for wrap-up (disposition) codes: one row per code with a code and a
 * label, add / remove buttons and a one-click set of examples when the list is empty.
 * A `/` in a code groups it (`billing/refund` shows as "Refund" under "billing").
 */
import { Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import { Trans, useTranslation } from 'react-i18next';

/** A disposition as stored in `TenantSettings.dispositions`. */
export type Code = { code: string; label: string };

/** Suggested starter codes; their labels are the `codes.examples.*` keys. */
const EXAMPLE_CODES = ['resolved', 'ticket', 'docs', 'escalated', 'callback'] as const;

/** Turns a label into a code: lowercase, words joined by `-`, `/` kept for grouping. */
function codeOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, '-')
    .replace(/-*\/-*/g, '/')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** See the module comment. */
export function CodesEditor({ value, onChange }: { value: Code[]; onChange: (v: Code[]) => void }) {
  const { t } = useTranslation('settings');
  const update = (i: number, part: Partial<Code>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...part } : c)));
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{t('codes.title')}</Typography>
      <Typography variant="body2" color="text.secondary">
        <Trans t={t} i18nKey="codes.hint" components={{ code: <code /> }} />
      </Typography>
      {value.map((c, i) => (
        <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField
            size="small"
            label={t('codes.label')}
            value={c.label}
            onChange={(e) =>
              update(i, {
                label: e.target.value,
                // keep the code in step while it still mirrors the label
                ...(c.code === codeOf(c.label) ? { code: codeOf(e.target.value) } : {}),
              })
            }
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            label={t('codes.code')}
            value={c.code}
            onChange={(e) => update(i, { code: e.target.value })}
            sx={{ width: 180 }}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          <IconButton
            size="small"
            aria-label={t('codes.remove', { label: c.label || c.code || i + 1 })}
            onClick={() => onChange(value.filter((_c, j) => j !== i))}
          >
            ✕
          </IconButton>
        </Stack>
      ))}
      <Stack direction="row" spacing={1}>
        <Button size="small" onClick={() => onChange([...value, { code: '', label: '' }])}>
          {t('codes.add')}
        </Button>
        {value.length === 0 && (
          <Button
            size="small"
            onClick={() =>
              onChange(EXAMPLE_CODES.map((code) => ({ code, label: t(`codes.examples.${code}`) })))
            }
          >
            {t('codes.addExamples')}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
