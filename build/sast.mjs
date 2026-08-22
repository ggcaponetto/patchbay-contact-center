#!/usr/bin/env node
/**
 * Static application security testing (SAST): `npm run sast`.
 *
 * Two scanners, both runnable on a laptop and in CI (`.github/workflows/sast.yml`):
 *
 * 1. `npm audit` — known vulnerabilities in the **production** dependency tree
 *    (`--omit=dev`), failing at `high` and above. Dev tooling (Vite, VitePress, …)
 *    is reported by a second, informational audit.
 * 2. Semgrep — pattern-based code analysis with the community rulesets for
 *    TypeScript/Node plus secrets detection. Runs the local `semgrep` binary when one
 *    is installed, otherwise the official `semgrep/semgrep` Docker image, so the only
 *    hard requirement is Docker. Findings with severity ERROR fail the run; WARNING and
 *    INFO findings are printed for review but do not block. Tests are excluded through
 *    `.semgrepignore`.
 *
 * Reports (SARIF + JSON) land in `reports/sast/`, which is git-ignored and uploaded
 * as a CI artifact. Exit code is non-zero on any blocking finding.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports', 'sast');
const RULESETS = ['p/default', 'p/typescript', 'p/nodejs', 'p/secrets'];
const SEMGREP_IMAGE = 'semgrep/semgrep:latest';
// `npm` is a .cmd shim on Windows that Node refuses to spawn without a shell; when run
// through an npm script, `npm_execpath` points at npm's JS entry, so run it with node.
const NPM = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['npm'];

/** Runs a command from the repo root, inheriting stdio; returns the exit status. */
function run(cmd, args) {
  const [bin, ...pre] = Array.isArray(cmd) ? cmd : [cmd];
  console.log(`sast: $ ${Array.isArray(cmd) ? 'npm' : cmd} ${args.join(' ')}`);
  const r = spawnSync(bin, [...pre, ...args], { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

/** True when `cmd --version` runs successfully. */
function has(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}

fs.mkdirSync(OUT, { recursive: true });
let failed = false;

// 1. Dependencies
if (run(NPM, ['audit', '--omit=dev', '--audit-level=high']) !== 0) {
  console.error('sast: npm audit found high/critical vulnerabilities in production dependencies.');
  failed = true;
}
if (run(NPM, ['audit', '--audit-level=high']) !== 0) {
  console.warn('sast: (advisory) high/critical vulnerabilities in dev dependencies; see above.');
}

// 2. Semgrep
const semgrepArgs = [
  'scan',
  ...RULESETS.flatMap((r) => ['--config', r]),
  '--metrics=off',
  '--sarif-output=reports/sast/semgrep.sarif',
  '--json-output=reports/sast/semgrep.json',
  '--text',
  '.',
];
let semgrep;
if (has('semgrep')) {
  semgrep = run('semgrep', semgrepArgs);
} else if (has('docker')) {
  // Mount the checkout as /src (the image's working dir); the reports are written
  // back through the same mount.
  semgrep = run('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT}:/src`,
    SEMGREP_IMAGE,
    'semgrep',
    ...semgrepArgs,
  ]);
} else {
  console.error('sast: neither `semgrep` nor `docker` is available; install one of them.');
  process.exit(1);
}
if (semgrep !== 0) {
  console.error(`sast: Semgrep did not complete (exit ${semgrep}).`);
  failed = true;
} else {
  // Semgrep only exits non-zero on findings with `--error`, which would block on
  // warnings too; decide from the report instead so WARNING stays advisory.
  const report = JSON.parse(fs.readFileSync(path.join(OUT, 'semgrep.json'), 'utf8'));
  const errors = report.results.filter((r) => r.extra.severity === 'ERROR');
  console.log(
    `sast: Semgrep ${report.results.length} finding(s), ${errors.length} blocking (ERROR)`,
  );
  if (errors.length > 0) {
    console.error('sast: blocking Semgrep findings (see reports/sast/semgrep.sarif).');
    failed = true;
  }
}

console.log(failed ? 'sast: FAILED' : 'sast: OK — no blocking findings');
process.exit(failed ? 1 : 0);
