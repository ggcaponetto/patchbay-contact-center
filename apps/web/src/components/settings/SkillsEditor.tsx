/**
 * Chip editor for skill/level pairs (a member's proficiencies or a queue's minimum
 * requirements). Pick or type a skill, choose a level 1–5, press Add; re-adding a skill
 * replaces its level; the chip's ✕ removes it. There is no free-text format to get wrong.
 */
import { Autocomplete, Button, Chip, MenuItem, Stack, TextField } from '@mui/material';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** One chip: a skill key (`billing`, `lang:de`) and a level 1–5. */
export type SkillLevel = { skill: string; level: number };

/** Language skills offered as suggestions everywhere. */
const LANGUAGES = ['lang:en', 'lang:de', 'lang:fr', 'lang:it', 'lang:es'];

/** See the module comment. `kind` names the number: a proficiency `level` or a `min` requirement. */
export function SkillsEditor({
  value,
  onChange,
  suggestions = [],
  label,
  kind = 'level',
}: {
  value: SkillLevel[];
  onChange: (next: SkillLevel[]) => void;
  suggestions?: string[];
  label: string;
  kind?: 'level' | 'min';
}) {
  const { t } = useTranslation('settings');
  const levelWord = t(kind === 'min' ? 'skills.minWord' : 'skills.levelWord');
  const [skill, setSkill] = useState('');
  const [level, setLevel] = useState(3);
  const options = [...new Set([...suggestions, ...LANGUAGES])].filter(
    (s) => !value.some((v) => v.skill === s),
  );
  const add = () => {
    const key = skill.trim().toLowerCase();
    if (!key) return;
    onChange([...value.filter((v) => v.skill !== key), { skill: key, level }]);
    setSkill('');
  };
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        {value.map((v) => (
          <Chip
            key={v.skill}
            label={t('skills.chip', { skill: v.skill, levelWord, level: v.level })}
            onDelete={() => onChange(value.filter((x) => x.skill !== v.skill))}
            size="small"
          />
        ))}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Autocomplete
          freeSolo
          size="small"
          options={options}
          inputValue={skill}
          onInputChange={(_e, v) => setSkill(v)}
          onChange={(_e, v) => setSkill(typeof v === 'string' ? v : '')}
          sx={{ minWidth: { xs: '100%', sm: 200 }, flex: 1 }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={label}
              placeholder={t('skills.placeholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          )}
        />
        <TextField
          select
          size="small"
          label={t(kind === 'min' ? 'skills.minLabel' : 'skills.levelLabel')}
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
          sx={{ width: { xs: '100%', sm: 90 } }}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <MenuItem key={n} value={n}>
              {n}
            </MenuItem>
          ))}
        </TextField>
        <Button size="small" onClick={add} disabled={!skill.trim()}>
          {t('common.add')}
        </Button>
      </Stack>
    </Stack>
  );
}
