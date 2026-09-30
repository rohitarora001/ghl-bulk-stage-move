---
id: module-db-schema
type: module
layer: backend
status: in-progress
tags: [prisma, postgres, schema, migrations, indexes]
files:
  - prisma/schema.prisma
  - prisma/migrations/20260930101428_base_schema/migration.sql
  - tests/setup/testDb.ts
  - tests/setup/env.ts
  - tests/setup/globalSetup.ts
  - tests/part1/schema.test.ts
completed: 2026-09-30
---

## What it does
Part 1's entities — workspaces, pipelines, stages, opportunities, transitions — plus the two
opportunity indexes the bulk job's snapshot and Part 1's keyset listing depend on, and the
partial unique index that makes a double-apply structurally impossible.

## Key decisions
- Pinned to Prisma 6. Prisma 7 rejects `url = env(...)` in `schema.prisma` (P1012) and requires
  `prisma.config.ts` plus a driver adapter, which would replace the design doc's documented
  `?connection_limit=` pool cap with `pg.Pool({ max })`.
- All names mapped to snake_case via `@map`/`@@map`, so the raw SQL the worker needs
  (`FOR UPDATE SKIP LOCKED`, the snapshot CTE, the finalize sweep) reads as ordinary Postgres
  instead of Prisma's quoted camelCase.
- UUID primary keys use `dbgenerated("gen_random_uuid()")`, not Prisma's `uuid()`: the worker
  inserts `transitions` rows through raw SQL, which needs a database-side default.
- `transitions.job_id` is a plain nullable uuid with no foreign key here — `jobs` does not exist
  until the later migration, which adds the constraint.

## Gotchas
- `transitions_job_opportunity_uq` is hand-appended to the generated `migration.sql` and must be
  preserved if that migration is ever regenerated. Prisma cannot express partial uniqueness.
- `prisma migrate reset` is gated behind `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` in 6.19 —
  it drops the database. Re-apply individual statements with psql instead.
- Jest `globalSetup` runs `prisma migrate deploy` before any test, so a schema test can never
  observe "relation does not exist". Prove a constraint's teeth by dropping it and re-running.
- `resetDb()` discovers tables from `pg_tables` rather than a hard-coded list, so later
  migrations are covered automatically. `RESTART IDENTITY` matters for `job_items.id`.

## Acceptance criteria
- [x] Second job-attributed transition rejected (P2002); manual transitions stack freely
- [x] Both opportunity indexes present and leading with `workspace_id`
- [x] Partial index recorded with `WHERE (job_id IS NOT NULL)`
- [x] 7/7 green, full suite 12/12, typecheck clean
- [ ] `jobs` / `job_items` tables and the deferred foreign key (later task)

## Update 2026-09-30 — jobs and job_items (Task 5)

Files added: `prisma/migrations/20260930103417_jobs_schema/migration.sql`,
`tests/db/jobsSchema.test.ts`. Also touched: `prisma/schema.prisma`,
`tests/setup/testDb.ts` (new `createJob(fixture, overrides)` helper),
`tests/part1/schema.test.ts`.

- Tables `jobs`, `job_items`; enums `job_status` (running|completed|failed),
  `job_item_status` (pending|done|skipped_conflict|failed).
- `job_items.status` IS the cursor. No separate persisted offset exists to drift out of step
  with the work.
- Two unique constraints, not application checks — racing requests both pass an existence check:
  `jobs_workspace_idempotency_uq (workspace_id, idempotency_key)` client-facing, per workspace so
  tenants cannot collide; `job_items_job_opportunity_uq (job_id, opportunity_id)` infra-facing.
- Hand-added partial indexes (Prisma cannot express a predicate):
  `jobs_running_progress_idx ON jobs (last_progress_at) WHERE status = 'running'` for the picker;
  `job_items_claimable_idx ON job_items (job_id, next_attempt_at, id) WHERE status = 'pending'`
  matching the claim query's ORDER BY, shrinking as the job completes.
- `transitions.job_id` is now a real FK (the deferral from the base migration is resolved),
  `onDelete: Cascade` — SetNull would turn a job transition into a false "manual move" record.
- `jobs.target_stage_id` FK is `onDelete: Restrict`: deleting the stage a running job targets
  would otherwise destroy the job silently.
- `job_items.opportunity_id` is deliberately NOT a FK: the snapshot is a historical guest list,
  and a cascade would shrink `total_count`'s denominator mid-job and make progress lie.
- Gotcha: `prisma migrate dev` reads `DATABASE_URL_ADMIN` (the datasource env var), not
  `DATABASE_URL` — passing the latter fails with P1012.
- Gotcha: the new FK broke two Task 2 tests that used invented job UUIDs. Fixed by adding a real
  job fixture, not by weakening the constraint.
- Suite after this task: 27/27 across 5 files.

## Review fix pass (commit 4246c1d)

- `jobs.request_fingerprint TEXT NULL` (migration `20260930190000_job_request_fingerprint`) — the
  409-on-key-reuse check in [[module-api-submission]]. Nullable on purpose: a null means "written
  before this column existed" and skips the comparison rather than turning old jobs into 409s.
- `job_items_claim_order_idx (job_id, id) WHERE status = 'pending'` (migration
  `20260930190500_job_items_claim_order_index`) — the index the claim query actually needs, hand-
  written because Prisma cannot express a partial index. `job_items_claimable_idx` is kept, not
  replaced: its column order is wrong for the claim and right for the picker's `EXISTS`.
