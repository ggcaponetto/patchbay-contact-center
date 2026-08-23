import { describe, expect, it } from 'vitest';
import de from './de.json';
import en from './en.json';
import itIT from './it.json';

/** `{ peers: { ai } }` → `['peers.ai']`, with the value next to each key. */
const flatten = (obj: object, prefix = ''): [string, string][] =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? flatten(v as object, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)]],
  );

const placeholders = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();

describe('call button locales', () => {
  const base = flatten(en);
  it.each([
    ['de', de],
    ['it', itIT],
  ])('%s mirrors en: same keys, same placeholders, nothing empty', (_, locale) => {
    const other = new Map(flatten(locale));
    expect([...other.keys()].sort()).toEqual(base.map(([k]) => k).sort());
    for (const [key, value] of base) {
      expect(other.get(key)?.trim(), key).not.toBe('');
      expect(placeholders(other.get(key)!), key).toEqual(placeholders(value));
    }
  });

  it('has no empty English value', () => {
    for (const [key, value] of base) expect(value.trim(), key).not.toBe('');
  });
});
