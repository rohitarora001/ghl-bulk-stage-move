---
id: module-seed
type: module
layer: backend
status: complete
tags: [seed, postgres, generate_series, benchmarks, fixtures]
files:
  - scripts/seed.ts
  - tests/db/seed.test.ts
completed: 2026-09-30
---

## What

Set-based demo/benchmark seeding. `seedWorkspace(prisma, { name, opportunityCount, stageNames?, ownerIds? })`
creates a workspace, a pipeline, the 12 `DEFAULT_STAGE_NAMES` stages, and N opportunities,
returning `{ workspaceId, pipelineId, stageIds, opportunityCount }`. `seedAll(prisma, large)`
drives the two datasets. CLI: `npm run seed [-- --reset] [--large]`.

## Key decisions

- One `INSERT ... SELECT ... FROM generate_series` per 50 000-row batch, never a row loop: the
  large dataset is 500 000 rows. Measured 500k + 5 neighbour workspaces in 34.3s; small demo
  (5 000 + 2x2 000) in 0.7s.
- Stage assignment is a weighted `CASE` over ONE `random()` draw per row (`bucket`), cumulative
  boundaries computed client-side from `STAGE_WEIGHTS`. Funnel-shaped, not uniform — a uniform
  spread makes every stage filter equally selective and proves nothing about the filter index.
- `created_at` = `now() - random() * interval '18 months'`, and `updated_at` copies it, so the
  date-range filter and keyset pagination have real spread to page through.
- `ANALYZE opportunities` at the end of every `seedWorkspace`, so the first benchmark run is not
  measuring a cold planner choosing a seq scan.
- 50 shared owner UUIDs, reused across workspaces via the `ownerIds` option, so an owner filter is
  selective but not unique-per-row and cross-workspace owner overlap exists to test isolation.
- `--reset` truncates tables DISCOVERED from `pg_tables` (excluding `_prisma%`), not a hardcoded
  list: `jobs`/`job_items` do not exist yet, and a literal list would rot at each migration.

## Gotchas

- Runs as the ADMIN role (`DATABASE_URL_ADMIN`) — `app_interactive`/`app_worker` hold no TRUNCATE
  or DDL grant by design, so the seed cannot use them.
- `opportunity_status` is a Postgres enum; the status array literal needs the explicit
  `::opportunity_status[]` cast.
- Reused by Task 14's full-scale seed and the benchmarks — change the signature there, not by
  copying it.

## Links

- depends-on: module-db-schema (tables, enum, indexes)
- related-to: config-repo-scaffold (npm `seed` script)

## Measured at full scale (Task 14)

`npm run seed -- --large` on Postgres 16 in a local container: **41.5s wall clock** for 518 770
rows across 6 workspaces (500 000 + five neighbours of 2 000-5 000). Ten
`INSERT ... SELECT ... generate_series` statements for the large workspace at BATCH_SIZE 50 000,
plus `ANALYZE`. The plan's bar was "minutes, not hours"; set-based costs seconds.

Funnel came out matching STAGE_WEIGHTS closely — 109 912 'New Lead' → 7 483 'On Hold' — so
stage-scoped filters have genuinely different selectivities for the benchmarks to measure.

**The benchmark dataset lives in its own database (`ghl_dev`), not `ghl_test`.** The suite
truncates every table between cases, so 500 000 rows in the test database would be destroyed by
the next `npm test` and would slow every truncate until then. Bootstrap is in the seed.ts header
comment: createdb, `npm run migrate` with `DATABASE_URL_ADMIN` pointed at it, then the seed.
