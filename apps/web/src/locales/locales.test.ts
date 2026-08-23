import { SUPPORTED_LANGUAGES } from '@cc/i18n';
import { AgentState, CallStatus } from '@cc/shared';
import { describe, expect, it } from 'vitest';
import deSettings from './de/settings.json';
import de from './de/translation.json';
import enSettings from './en/settings.json';
import en from './en/translation.json';
import itSettings from './it/settings.json';
import itTranslation from './it/translation.json';

type Bundle = Record<string, unknown>;
const NAMESPACES: Record<string, Record<(typeof SUPPORTED_LANGUAGES)[number], Bundle>> = {
  translation: { en, de, it: itTranslation },
  settings: { en: enSettings, de: deSettings, it: itSettings },
};

/** Every API error code the desk can receive (grep `error: '` in apps/api/src). */
const ERROR_CODES = [
  'already_held',
  'call_over',
  'closed',
  'disposition_required',
  'empty_target',
  'forbidden',
  'invalid_body',
  'invalid_email',
  'invalid_state',
  'last_queue',
  'no_consultant',
  'no_tenant',
  'not_found',
  'not_held',
  'not_in_acw',
  'not_live',
  'not_ringing_you',
  'not_wav',
  'offline',
  'on_call',
  'origin_not_allowed',
  'recording_unavailable',
  'too_large',
  'unauthenticated',
  'unknown_code',
  'unknown_embed_key_or_queue',
  'unsupported_type',
  'generic',
];

/** `{ a: { b: 'x' } }` → `{ 'a.b': 'x' }`. */
function flatten(bundle: Bundle, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bundle)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v as Bundle, key));
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe.each(Object.keys(NAMESPACES))('locales: %s namespace', (ns) => {
  const bundles = NAMESPACES[ns]!;
  const flat = Object.fromEntries(
    SUPPORTED_LANGUAGES.map((lng) => [lng, flatten(bundles[lng])] as const),
  );
  const reference = flat.en!;

  it('has the same keys in every language', () => {
    for (const lng of SUPPORTED_LANGUAGES)
      expect(Object.keys(flat[lng]!).sort()).toEqual(Object.keys(reference).sort());
  });

  it('has no empty values', () => {
    for (const lng of SUPPORTED_LANGUAGES)
      for (const [key, value] of Object.entries(flat[lng]!))
        expect(value.trim(), `${lng}:${key}`).not.toBe('');
  });

  it('keeps the same {{placeholders}} per key', () => {
    for (const lng of SUPPORTED_LANGUAGES)
      for (const [key, value] of Object.entries(flat[lng]!))
        expect(placeholders(value), `${lng}:${key}`).toEqual(placeholders(reference[key]!));
  });

  it('pairs every _one plural with an _other', () => {
    for (const key of Object.keys(reference)) {
      if (key.endsWith('_one')) expect(reference[`${key.slice(0, -4)}_other`]).toBeDefined();
      if (key.endsWith('_other')) expect(reference[`${key.slice(0, -6)}_one`]).toBeDefined();
    }
  });
});

describe('locales: translation namespace contents', () => {
  const reference = flatten(en);

  it('labels every agent state and call status', () => {
    for (const state of AgentState.options) expect(reference[`states.${state}`]).toBeTruthy();
    for (const status of CallStatus.options) expect(reference[`statuses.${status}`]).toBeTruthy();
  });

  it('explains every API error code', () => {
    for (const code of ERROR_CODES) expect(reference[`errors.${code}`], code).toBeTruthy();
  });
});
