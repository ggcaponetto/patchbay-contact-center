#!/usr/bin/env node
/**
 * Repo size gate: counts non-blank lines in git-tracked source files and FAILS when
 * **product code** exceeds 50k or **tests** exceed 50k. The point is solo-developer
 * maintainability — the repo must stay small enough for one person to hold in their
 * head. Part of `npm run validate`; raising a budget is a user decision, not a fix.
 *
 * Product and tests are budgeted separately because the quality gates (90% coverage,
 * one e2e test per feature) make tests track product code roughly 1:1: a single budget
 * would be spent half on tests and stop being a design constraint. The product budget
 * is the one that shapes the product; the test budget only catches runaway suites.
 *
 * The POC has a softer target of 20k product lines: exceeding it prints a warning so
 * the drift is visible long before the hard gate trips.
 *
 * Only git-tracked files count, so generated output (dist/, docs/api/, coverage/) is
 * excluded by construction. Markdown/JSON/YAML are config and docs, not code — excluded
 * on purpose; don't dodge the gate by moving logic into an uncounted extension.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_BUDGET = 50_000;
const TEST_BUDGET = 50_000;
const POC_TARGET = 20_000;
const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|html|css)$/;
/** Unit/integration tests next to the code, the e2e/load suites, and the shared test helpers. */
const TEST_FILE = /(\.test\.[cm]?[jt]sx?$|^tests\/|\/testing\.ts$)/;

const ls = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
if (ls.status !== 0) {
  console.error(`loc: git ls-files failed\n${ls.stderr ?? ''}`);
  process.exit(1);
}

const byDir = new Map();
let product = 0;
let tests = 0;
for (const file of ls.stdout.split(/\r?\n/)) {
  if (!CODE_EXT.test(file)) continue;
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue; // tracked but deleted in the working tree
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  if (TEST_FILE.test(file)) {
    tests += lines;
    continue;
  }
  const parts = file.split('/');
  const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : '.';
  byDir.set(dir, (byDir.get(dir) ?? 0) + lines);
  product += lines;
}

for (const [dir, lines] of [...byDir].sort((a, b) => b[1] - a[1])) {
  console.log(`loc: ${String(lines).padStart(6)}  ${dir}`);
}
const pct = (n, budget) => Math.round((n / budget) * 100);
console.log(
  `loc: ${String(product).padStart(6)}  product total (${pct(product, PRODUCT_BUDGET)}% of the ${PRODUCT_BUDGET} budget)`,
);
console.log(
  `loc: ${String(tests).padStart(6)}  tests total (${pct(tests, TEST_BUDGET)}% of the ${TEST_BUDGET} budget)`,
);

if (product > POC_TARGET) {
  console.warn(`loc: WARNING — ${product} product lines exceed the ${POC_TARGET} POC target.`);
}
let failed = false;
if (product > PRODUCT_BUDGET) {
  console.error(
    `loc: FAILED — ${product} non-blank product lines exceed the ${PRODUCT_BUDGET} budget. ` +
      `Delete or simplify before adding more; the budget keeps this repo solo-maintainable.`,
  );
  failed = true;
}
if (tests > TEST_BUDGET) {
  console.error(
    `loc: FAILED — ${tests} non-blank test lines exceed the ${TEST_BUDGET} budget. ` +
      `Fold duplicated setups into helpers; do not delete coverage to pass.`,
  );
  failed = true;
}
if (failed) process.exit(1);
