# Build scripts

## `loc.mjs` — the repo size gate

`npm run loc` (part of `npm run validate` and CI) counts non-blank lines in git-tracked source files and fails when the total exceeds **50 000**. A softer **20 000** POC target prints a warning so drift is visible long before the hard gate trips.

What counts:

- only files listed by `git ls-files`, so generated output (`dist/`, `docs/api/`, `coverage/`) is excluded by construction;
- only code extensions: `.ts .tsx .mts .cts .js .mjs .cjs .jsx .html .css`;
- blank lines are skipped; everything else (comments included) counts.

Markdown, JSON and YAML are config and docs, not code, and are excluded on purpose. Do not dodge the gate by moving logic into an uncounted extension.

The script prints a per-folder breakdown (first two path segments, e.g. `apps/api`) sorted by size, then the total as a percentage of the budget:

```
loc:   3214  apps/api
loc:   1697  apps/web
...
loc:   5577  total (11% of the 50000 budget)
```

### Why

The budget exists for solo-developer maintainability: the repo must stay small enough for one person to hold in their head. Raising `BUDGET` in `build/loc.mjs` is a product decision, not a fix for a failing gate — delete or simplify code instead.
