#!/usr/bin/env node
/**
 * Test-plan gate: `npm run e2e-plan` (part of `validate`). Keeps tests/e2e/TEST-PLAN.md
 * and the Playwright specs in sync, so feature coverage is a checked fact, not a hope:
 *
 * - every row with status `implemented` has exactly one test tagged with its id;
 * - every `@E2E-nn` tag found in a spec has a row in the plan;
 * - every test carries exactly one tier tag (`@smoke` | `@core` | `@cloud`), at least one
 *   area tag and exactly one plan id, and the tier matches the row's tier column;
 * - rows that are `planned` / `blocked` have no test yet.
 *
 * Prints every violation and exits non-zero on any. No dependencies: the plan table is
 * parsed with a regex, the specs with another.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = path.join(ROOT, 'tests', 'e2e', 'TEST-PLAN.md');
const SPECS = path.join(ROOT, 'tests', 'e2e', 'specs');
const TIERS = ['smoke', 'core', 'cloud'];
const AREAS = ['embed', 'desk', 'supervisor', 'settings', 'history', 'ai'];

/** Plan rows: `| E2E-07 | feature | area | tier | spec | status |`. */
function readPlan() {
  const rows = new Map();
  for (const line of fs.readFileSync(PLAN, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(E2E-\d+)\s*\|(.*)\|\s*(smoke|core|cloud)\s*\|[^|]*\|\s*(\w+)/.exec(line);
    if (m) rows.set(m[1], { tier: m[3], status: m[4] });
  }
  return rows;
}

/** Every `test(...)` call's tag array, found by its `{ tag: [...] }` option. */
function readSpecs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) readSpecs(file, out);
    else if (entry.name.endsWith('.spec.ts')) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SPECS, file).replaceAll('\\', '/');
      for (const m of text.matchAll(/tag:\s*\[([^\]]*)\]/g)) {
        const tags = [...m[1].matchAll(/'(@[\w-]+)'/g)].map((t) => t[1]);
        // `behavior === 'leave' ? '@E2E-27' : '@E2E-28'` style: every quoted tag counts
        out.push({ file: rel, tags });
      }
    }
  }
  return out;
}

const plan = readPlan();
const specs = readSpecs(SPECS);
const problems = [];
const seen = new Map();

for (const { file, tags } of specs) {
  const tiers = tags.filter((t) => TIERS.includes(t.slice(1)));
  const areas = tags.filter((t) => AREAS.includes(t.slice(1)));
  const ids = tags.filter((t) => /^@E2E-\d+$/.test(t)).map((t) => t.slice(1));
  if (tiers.length !== 1)
    problems.push(`${file}: ${tags.join(' ')} — exactly one tier tag expected`);
  if (areas.length === 0) problems.push(`${file}: ${tags.join(' ')} — an area tag is missing`);
  if (ids.length === 0)
    problems.push(`${file}: ${tags.join(' ')} — the @E2E-nn plan id is missing`);
  for (const id of ids) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
    const row = plan.get(id);
    if (!row) problems.push(`${file}: ${id} has no row in tests/e2e/TEST-PLAN.md`);
    else if (tiers[0] && row.tier !== tiers[0].slice(1))
      problems.push(`${file}: ${id} is tagged ${tiers[0]} but the plan says ${row.tier}`);
  }
}
for (const [id, row] of plan) {
  const n = seen.get(id) ?? 0;
  if (row.status === 'implemented' && n === 0)
    problems.push(`${id}: implemented in the plan but no test carries @${id}`);
  if (row.status !== 'implemented' && n > 0)
    problems.push(`${id}: has a test but the plan says ${row.status}`);
}
// A parameterized test may legitimately reuse one tag array for several ids (one each).
for (const [id, n] of seen) if (n > 1) problems.push(`${id}: tagged on ${n} tests, expected one`);

if (problems.length) {
  console.error(`e2e-plan: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const implemented = [...plan.values()].filter((r) => r.status === 'implemented').length;
console.log(`e2e-plan: OK — ${implemented}/${plan.size} planned features have a tagged test`);
