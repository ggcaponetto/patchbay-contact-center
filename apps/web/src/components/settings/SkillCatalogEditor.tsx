/**
 * List editor for the tenant's routing skill catalogue (`TenantSettings.skills`): one
 * row per skill with a label, a key (slugged from the label while it still mirrors it,
 * editable, validated against `/^[a-z0-9][a-z0-9-]*$/`) and a description telling the AI
 * when the skill applies. Languages are not listed here: the AI detects them and the
 * router matches `lang:xx` skills automatically.
 */
import type { RoutingSkill } from '@cc/shared';
import { Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

/** A valid catalogue key: lowercase letters, digits and dashes, not starting with a dash. */
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Turns a label into a key: lowercase, words joined by `-`, at most 40 characters. */
export function keyOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** True when `key` is a valid catalogue key. */
export const validKey = (key: string): boolean => KEY_RE.test(key);

/** See the module comment. */
export function SkillCatalogEditor({
  value,
  onChange,
}: {
  value: RoutingSkill[];
  onChange: (v: RoutingSkill[]) => void;
}) {
  const { t } = useTranslation('settings');
  const update = (i: number, part: Partial<RoutingSkill>) =>
    onChange(value.map((s, j) => (j === i ? { ...s, ...part } : s)));
  return (
    <Stack spacing={1}>
      {value.map((s, i) => (
        <Stack
          key={i}
          direction="row"
          spacing={1}
          sx={{ alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 1 }}
        >
          <TextField
            size="small"
            label={t('skillCatalog.label')}
            value={s.label}
            onChange={(e) =>
              update(i, {
                label: e.target.value,
                // keep the key in step while it still mirrors the label
                ...(s.key === keyOf(s.label) ? { key: keyOf(e.target.value) } : {}),
              })
            }
            sx={{ flex: 1, minWidth: { xs: '100%', sm: 160 } }}
          />
          <TextField
            size="small"
            label={t('skillCatalog.key')}
            value={s.key}
            error={!validKey(s.key)}
            helperText={validKey(s.key) ? undefined : t('skillCatalog.invalidKey')}
            onChange={(e) => update(i, { key: e.target.value })}
            sx={{ width: { xs: '100%', sm: 160 } }}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          <TextField
            size="small"
            label={t('skillCatalog.description')}
            value={s.description}
            onChange={(e) => update(i, { description: e.target.value.slice(0, 200) })}
            sx={{ flex: 2, minWidth: { xs: '100%', sm: 220 } }}
          />
          <IconButton
            size="small"
            aria-label={t('skillCatalog.remove', { label: s.label || s.key || i + 1 })}
            onClick={() => onChange(value.filter((_s, j) => j !== i))}
          >
            ✕
          </IconButton>
        </Stack>
      ))}
      {value.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('skillCatalog.empty')}
        </Typography>
      )}
      <div>
        <Button
          size="small"
          onClick={() => onChange([...value, { key: '', label: '', description: '' }])}
        >
          {t('skillCatalog.add')}
        </Button>
      </div>
    </Stack>
  );
}
