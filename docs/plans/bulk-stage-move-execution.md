# Bulk Stage Move — Execution Plan (task-structured)

**Spec / design authority:** `C:\Users\rohit\.claude\plans\lets-start-planning-about-compiled-lobster.md`
(referred to below as *the design doc*). Where this file and the design doc disagree, the
design doc wins and the divergence gets a ledger `Ruling:` line.

This file exists because the design doc is prose — it has no `## Task N` headings, so the
`task-brief` extractor cannot slice it. Task bodies below restate the design doc's decisions
in executable form; rationale stays in the design doc.

## Global Constraints

- **Stack:** Node 22 + TypeScript + Express + Prisma + PostgreSQL. No Redis/Kafka/BullMQ.
- **TDD is mandatory.** Every production change is preceded by a test that was watched to fail.
- **Two Prisma clients, two Postgres roles.** `interactivePrisma` (role `app_interactive`,
  `connection_limit=15`, `statement_timeout=10s`) for API handlers; `jobPrisma` (role
  `app_worker`, `connection_limit=3`, `statement_timeout=30s`) for the worker. Migrations and
  seeds use a third admin connection.
- **Every query filters `workspace_id` first.** Every index leads with `workspace_id`.
- **Raw SQL only where Prisma's API cannot express the query:** the claim
  (`FOR UPDATE SKIP LOCKED`), the locked read (`ORDER BY id FOR UPDATE`), the snapshot CTE,
  the finalize sweep, the progress aggregate. Everything else goes through Prisma's typed API.
- **Test database:** `postgresql://postgres:postgres@localhost:55433/ghl_test` (podman
  container `ghl-pgtest`, Postgres 16). The dev/demo database is the `postgres` service in
  `docker-compose.yml`.
- **`docker` is not installed on this machine**; `podman` 5.8.3 plus `docker-compose` v5.5.0
  are. Compose verification uses `podman compose`. The shipped file and documented command
  remain `docker compose up`.

## Environment Variables (single source of truth, `src/shared/config.ts`)

| Name | Default | Used by |
|---|---|---|
| `DATABASE_URL_ADMIN` | — | migrations, seed, tests' setup |
| `DATABASE_URL_INTERACTIVE` | — | `interactivePrisma` |
| `DATABASE_URL_WORKER` | — | `jobPrisma` |
| `PORT` | `3000` | api |
| `CHUNK_SIZE` | `500` | worker |
| `BULK_MAX_ITEMS` | `50000` | submission cap (lowered by truncation tests) |
| `WORKER_POOL_SIZE` | `3` | worker loop count, must equal worker `connection_limit` |
| `MAX_ATTEMPTS` | `5` | poison-chunk terminal threshold |
| `SWEEP_INTERVAL_MS` | `2000` | finalize sweep time gate |
| `IDLE_BACKOFF_MS` | `250` | worker idle sleep |
| `CLAIM_BACKOFF_MS` | `500` | worker tier-1 sleep |

---

## Task 1: Project scaffold, config, logger

**Goal.** A TypeScript project that builds, lints-free, and runs Jest against the podman test
Postgres, with `config.ts` parsing and validating every env var in the table above.

**Interfaces — Produces:**
- `src/shared/config.ts` → `export const config: Config`, `export function loadConfig(env: NodeJS.ProcessEnv): Config`
  with fields `databaseUrlAdmin`, `databaseUrlInteractive`, `databaseUrlWorker`, `port`,
  `chunkSize`, `bulkMaxItems`, `workerPoolSize`, `maxAttempts`, `sweepIntervalMs`,
  `idleBackoffMs`, `claimBackoffMs`.
- `src/shared/logger.ts` → `export const logger` with `info/warn/error/debug(msg, meta?)`.
- npm scripts: `build`, `test`, `lint`, `typecheck`.

**Steps:**
1. `npm init -y`; install deps: `express`, `@prisma/client`, `zod`; dev deps: `typescript`,
   `@types/node`, `@types/express`, `ts-node`, `ts-node-dev`, `prisma`, `jest`, `ts-jest`,
   `@types/jest`, `supertest`, `@types/supertest`, `concurrently`, `cross-env`.
   Expected: `npm ls --depth=0` lists all of them, exit 0.
2. Write `tsconfig.json` (target ES2022, module commonjs, strict, outDir dist, rootDir .) and
   `jest.config.js` (ts-jest preset, testEnvironment node, `testMatch` `tests/**/*.test.ts`,
   `globalSetup`/`globalTeardown` placeholders left unset until Task 2, `testTimeout: 30000`,
   `maxWorkers: 1`).
3. RED: `tests/unit/config.test.ts` — asserts (a) `loadConfig` with all three DATABASE_URLs
   present returns defaults `chunkSize 500`, `bulkMaxItems 50000`, `workerPoolSize 3`,
   `maxAttempts 5`, `sweepIntervalMs 2000`; (b) `loadConfig({})` throws an error naming the
   missing `DATABASE_URL_ADMIN`; (c) `BULK_MAX_ITEMS=7` is honoured as the number `7`, not the
   string; (d) `WORKER_POOL_SIZE` that disagrees with the `connection_limit` in
   `DATABASE_URL_WORKER` throws (the design doc's "the cap is the number" invariant —
   `WORKER_POOL_SIZE` loops each hold one of the worker's connections, so a pool smaller than
   the loop count deadlocks the worker at boot).
   Run it. Expected: FAIL — `Cannot find module '../../src/shared/config'`.
4. GREEN: implement `src/shared/config.ts` with zod, and `src/shared/logger.ts` (JSON lines to
   stdout, level from `LOG_LEVEL`, default `info`).
   Run it. Expected: PASS, 4/4.
5. Commit `chore: project scaffold, typed config, logger`.

**Test command:** `npx jest tests/unit/config.test.ts`

---

## Task 2: Base schema — workspaces, pipelines, stages, opportunities, transitions

**Goal.** Prisma schema + migration for Part 1's entities, with every index the design doc
names, including the partial unique index on `transitions` that Prisma cannot express.

**Interfaces — Produces:** `prisma/schema.prisma`; `prisma/migrations/**`; table names
`workspaces`, `pipelines`, `stages`, `opportunities`, `transitions`; enum
`opportunity_status`; `tests/setup/testDb.ts` exporting `adminPrisma`, `resetDb()`,
`seedBaseFixture()`.

**Schema (snake_case via `@map`/`@@map` so raw SQL reads naturally):**
- `workspaces(id uuid pk, name text, created_at)`
- `pipelines(id uuid pk, workspace_id fk, name text, created_at)`; index `(workspace_id)`
- `stages(id uuid pk, workspace_id fk, pipeline_id fk, name text, position int, created_at)`;
  unique `(pipeline_id, position)`; index `(workspace_id, pipeline_id)`
- `opportunities(id uuid pk, workspace_id fk, pipeline_id fk, stage_id fk, name text,
  value numeric(14,2), status opportunity_status, owner_id uuid, version int default 1,
  created_at, updated_at)`
  - index `idx_opportunities_filter (workspace_id, stage_id, owner_id, status, created_at, value)`
  - index `idx_opportunities_stage_list (workspace_id, stage_id, created_at, id)`
- `transitions(id uuid pk, opportunity_id fk, workspace_id fk, from_stage_id uuid null,
  to_stage_id uuid, job_id uuid null, created_at)`
  - index `(job_id)`
  - **hand-added** `CREATE UNIQUE INDEX transitions_job_opportunity_uq ON transitions (job_id, opportunity_id) WHERE job_id IS NOT NULL;`

**Steps:**
1. Write `prisma/schema.prisma` for the models above. Generate the migration against the test
   DB: `DATABASE_URL=<test url> npx prisma migrate dev --name base_schema --create-only`.
   Expected: a `prisma/migrations/<ts>_base_schema/migration.sql` is written.
2. Hand-edit that `migration.sql`, appending the partial unique index above with a comment
   saying it is hand-added because Prisma cannot express partial uniqueness. Expected:
   `grep -c 'WHERE job_id IS NOT NULL' migration.sql` → `1`.
3. Write `tests/setup/testDb.ts`: an admin `PrismaClient` on `DATABASE_URL_ADMIN`, a
   `resetDb()` that `TRUNCATE`s every table in dependency order restarting identities, and a
   `seedBaseFixture()` creating two workspaces each with one pipeline and 3 stages, returning
   their ids. Wire `globalSetup` in `jest.config.js` to run `prisma migrate deploy` against
   the test DB.
4. RED: `tests/part1/schema.test.ts` — (a) inserting two `transitions` rows with the same
   `(job_id, opportunity_id)` and a non-null `job_id` rejects with Postgres `23505`;
   (b) two rows with `job_id IS NULL` for the same opportunity both insert fine;
   (c) `idx_opportunities_filter` and `idx_opportunities_stage_list` both exist in
   `pg_indexes`. Run it. Expected: FAIL — relation `workspaces` does not exist (migration not
   yet applied) or the module is missing.
5. GREEN: apply migrations (`npx prisma migrate deploy`), `npx prisma generate`. Re-run.
   Expected: PASS, 3/3.
6. Commit `feat(db): base schema, indexes, partial unique index on job transitions`.

**Test command:** `npx jest tests/part1/schema.test.ts`

---

## Task 3: Two Postgres roles, two Prisma clients

**Goal.** `app_interactive` and `app_worker` roles exist with server-side `statement_timeout`s
and exactly the privileges they need; `prismaClients.ts` exposes the two capped clients; a
custom migrate runner creates roles before migrating and grants after.

**Interfaces — Produces:**
- `prisma/sql/000_roles.sql` — idempotent (`DO $$ ... IF NOT EXISTS ... $$`) role creation +
  `ALTER ROLE app_interactive SET statement_timeout = '10s'`, `app_worker` `'30s'`.
- `prisma/sql/999_grants.sql` — `GRANT USAGE ON SCHEMA public` + `SELECT, INSERT, UPDATE` on
  all tables and `USAGE` on sequences, to both roles.
- `scripts/migrate.ts` → runs `000_roles.sql`, then `prisma migrate deploy`, then
  `999_grants.sql`, all against `DATABASE_URL_ADMIN`.
- `src/db/prismaClients.ts` → `interactivePrisma`, `jobPrisma`, `disconnectAll()`.

**Steps:**
1. RED: `tests/db/roles.test.ts` — (a) `SELECT rolconfig FROM pg_roles WHERE rolname='app_worker'`
   contains `statement_timeout=30s`, and `app_interactive` contains `statement_timeout=10s`;
   (b) connecting as `app_worker` and running `SELECT pg_sleep(35)` fails with SQLSTATE `57014`
   (`statement_timeout`) — proving the timeout is enforced server-side, not just declared;
   (c) `current_setting('statement_timeout')` on `jobPrisma` returns `30s` and on
   `interactivePrisma` returns `10s`, proving each client authenticated as the right role.
   Run it. Expected: FAIL — role `app_worker` does not exist.
2. GREEN: write the two SQL files and `scripts/migrate.ts`; run `npm run migrate` against the
   test DB; write `src/db/prismaClients.ts` building each client from its own URL.
   Re-run. Expected: PASS, 3/3. (b) takes ~30s — acceptable, `testTimeout` is 30s so raise
   this file's timeout to 60s explicitly.
3. Commit `feat(db): dedicated interactive/worker roles with server-side statement timeouts`.

**Test command:** `npx jest tests/db/roles.test.ts`

---

## Task 4: Seed script (small scale)

**Goal.** A set-based seed producing a demo workspace with a 12-stage pipeline and a few
thousand opportunities, fast enough to run inside `docker compose up`.

**Interfaces — Produces:** `scripts/seed.ts`; npm script `seed`; exported
`seedWorkspace(prisma, { name, opportunityCount, stageNames })` reusable by benchmarks and
Task 13's large seed.

**Steps:**
1. RED: `tests/db/seed.test.ts` — run `seedWorkspace` with `opportunityCount: 2000`; assert
   exactly 2000 opportunities exist for that workspace, all 12 stages are present, every
   opportunity's `stage_id` belongs to that workspace's pipeline, `created_at` values span
   more than 30 days (proving the spread, not all `now()`), and at least 10 distinct
   `owner_id`s appear. Run it. Expected: FAIL — module not found.
2. GREEN: implement using `INSERT ... SELECT ... FROM generate_series(1, $n)` with a weighted
   `CASE` over the 12 stage ids, `now() - (random() * interval '18 months')`, ~50 pre-generated
   owner UUIDs, batched 50 000 rows per statement; `ANALYZE opportunities` at the end.
   Re-run. Expected: PASS, 5/5.
3. Add `--reset` and `--large` flags to the CLI entrypoint (`--large` is exercised in Task 13).
   Commit `feat(seed): set-based seeding with 12-stage funnel distribution`.

**Test command:** `npx jest tests/db/seed.test.ts`

---

## Task 5: Jobs and job_items schema

**Goal.** The bulk-job tables and every index the claim/progress/picker queries depend on.

**Interfaces — Produces:** tables `jobs`, `job_items`; enums `job_status`
(`running|completed|failed`), `job_item_status` (`pending|done|skipped_conflict|failed`).

- `jobs(id uuid pk, workspace_id fk, idempotency_key text, filter jsonb, target_stage_id uuid,
  status job_status default 'running', total_count int, matched_count int null,
  truncated bool default false, last_progress_at timestamptz null, error_message text null,
  created_at)`
  - unique `(workspace_id, idempotency_key)`
  - **hand-added** `CREATE INDEX jobs_running_progress_idx ON jobs (last_progress_at) WHERE status = 'running';`
- `job_items(id bigserial pk, job_id fk, opportunity_id uuid, expected_version int,
  status job_item_status default 'pending', attempts int default 0,
  next_attempt_at timestamptz default now(), last_error text null, created_at)`
  - unique `(job_id, opportunity_id)`
  - index `(job_id, status)`
  - **hand-added** `CREATE INDEX job_items_claimable_idx ON job_items (job_id, next_attempt_at, id) WHERE status = 'pending';`

**Steps:**
1. RED: `tests/db/jobsSchema.test.ts` — (a) duplicate `(workspace_id, idempotency_key)` rejects
   with `23505`; same key in a different workspace inserts fine; (b) duplicate
   `(job_id, opportunity_id)` rejects with `23505`; (c) all three hand-added indexes appear in
   `pg_indexes` with the expected `WHERE` clause text. Run. Expected: FAIL — relation `jobs`
   does not exist.
2. GREEN: extend `schema.prisma`, `prisma migrate dev --create-only --name jobs_schema`,
   hand-edit the SQL to add the two partial indexes, `npm run migrate`, `prisma generate`.
   Re-run. Expected: PASS, 3/3.
3. Commit `feat(db): jobs and job_items with claim/progress/picker indexes`.

**Test command:** `npx jest tests/db/jobsSchema.test.ts`

---

## Task 6: API server, workspace scope, bulk-move submission

**Goal.** `POST /jobs/bulk-move` — dedupe by `Idempotency-Key`, validate the target stage,
snapshot the match set with one server-side CTE, report truncation, survive a concurrent
duplicate submission.

**Interfaces — Produces:**
- `src/api/server.ts` → `export function createApp(): express.Express` (no `listen`, so
  supertest can drive it), `src/api/index.ts` doing the `listen`.
- `src/api/middleware/workspaceScope.ts` → validates `X-Workspace-Id` against `workspaces`,
  400 otherwise, sets `req.workspaceId`.
- `src/api/services/jobService.ts` → `submitBulkMoveJob({ workspaceId, idempotencyKey, filter, targetStageId })`
  returning `{ job, created: boolean }`.
- Response body: `{ jobId, totalCount, matchedCount, truncated }`; 202 on create, 200 on
  replay of an existing key.

**Consumes:** Task 5's `jobs`/`job_items`; Task 3's `interactivePrisma`; Task 1's
`config.bulkMaxItems`.

**The snapshot statement (raw, one round trip, no ids cross the wire):**
```sql
WITH picked AS (
  SELECT id, version, created_at
  FROM opportunities
  WHERE workspace_id = $1 AND <filter predicates>
  ORDER BY created_at, id
  LIMIT $limitPlusOne
),
ins AS (
  INSERT INTO job_items (job_id, opportunity_id, expected_version, status)
  SELECT $jobId, id, version, 'pending' FROM picked ORDER BY created_at, id LIMIT $limit
  RETURNING 1
)
SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT count(*) FROM picked) AS probed;
```
No window function — see the design doc's "Correction from an earlier draft".

**Steps:**
1. RED: `tests/part2/submission.test.ts` — (a) missing/unknown `X-Workspace-Id` → 400;
   (b) valid submission returns 202 with `totalCount` equal to the number of matching
   opportunities, `truncated: false`, `matchedCount === totalCount`, and exactly that many
   `job_items` rows all `pending` with `expected_version` matching each opportunity's current
   `version`; (c) a `targetStageId` from another workspace → 400 and zero `jobs`/`job_items`
   rows created; (d) a `targetStageId` in a different pipeline of the *same* workspace → 400.
   Run. Expected: FAIL — module `src/api/server` not found.
2. GREEN: implement `createApp`, `workspaceScope`, the route and `submitBulkMoveJob`,
   including the two stage-validation clauses (`workspace_id = $ws AND pipeline_id = <the
   filter's/opportunity's pipeline>`; for bulk, the filter's matched set must all belong to the
   target stage's pipeline — enforce by adding `pipeline_id = <target stage's pipeline>` to
   the snapshot predicate, which also makes the cross-pipeline rule true for bulk by
   construction). Re-run. Expected: PASS, 4/4.
3. RED: `tests/part2/idempotency.test.ts` — same key twice → same `jobId`, second response 200,
   `job_items` count unchanged; same key from a different workspace → a different `jobId`.
   Run. Expected: FAIL on the second submission creating a second job.
4. GREEN: add the `(workspace_id, idempotency_key)` pre-check. Re-run. Expected: PASS, 2/2.
5. RED: `tests/part2/idempotencyKeyRace.test.ts` — two concurrent `POST`s with the same key via
   `Promise.all`; assert both resolve 2xx with the same `jobId`, exactly one `jobs` row, and
   one snapshot's worth of `job_items`. Run. Expected: FAIL — one request 500s with `23505`.
6. GREEN: catch `23505` on the jobs insert and re-fetch-and-return the winner's job (200).
   Re-run. Expected: PASS.
7. RED: `tests/part2/truncation.test.ts` — with `BULK_MAX_ITEMS` lowered to e.g. 10: truncated
   case asserts `truncated === true`, `matchedCount === null`, `totalCount === 10`,
   `job_items` count `=== 10`, and that the retained rows are the 10 *oldest* by
   `(created_at, id)`; non-truncated case asserts `truncated === false` and
   `matchedCount === totalCount`. Run. Expected: FAIL.
8. GREEN: implement the probe/cap semantics. Re-run. Expected: PASS, both variants.
9. `EXPLAIN ANALYZE` both filter shapes (stage-only, and status+valueMin) against the seeded
   data; record the plan node types in a comment in `jobService.ts`. Expected: stage-only shows
   an index scan on `idx_opportunities_stage_list` with no sort node; broad filter shows a
   top-N heapsort — confirming the design doc's reworded claim.
10. Commit `feat(api): bulk-move submission with snapshot CTE, idempotency and truncation`.

**Test command:** `npx jest tests/part2/submission.test.ts tests/part2/idempotency.test.ts tests/part2/idempotencyKeyRace.test.ts tests/part2/truncation.test.ts`

---

## Task 7: Worker — single-transaction claim+apply, poison retry, finalize sweep

**Goal.** The core of the exercise. `claimAndApplyChunk` is ONE transaction; the picker only
returns jobs with claimable work; finalization is a decoupled, time-gated, set-based, atomic
sweep.

**Interfaces — Produces:**
- `src/worker/claimAndApplyChunk.ts` → `claimAndApplyChunk(prisma, jobId): Promise<ChunkResult>`
  where `ChunkResult = { outcome: 'claim-error' } | { outcome: 'applied', claimedCount, doneCount, conflictCount }`
  and on apply failure `{ outcome: 'apply-error', claimedCount }` after `recordChunkFailure` ran.
- `src/worker/queries.ts` → `pickJobWithClaimableWork(prisma)`, `runFinalizeSweep(prisma)`,
  `touchLastProgress(prisma, jobId)`, `recordChunkFailure(prisma, jobId, opportunityIds, error)`.
- `src/worker/index.ts` → `runLoop(loopId, signal)`, `startWorker()`, graceful `SIGTERM`.

**Consumes:** Task 5's tables and indexes; Task 3's `jobPrisma`; Task 1's `chunkSize`,
`workerPoolSize`, `maxAttempts`, `sweepIntervalMs`, backoffs.

**`claimAndApplyChunk` — one interactive transaction, `timeout: 60_000`, `maxWait: 30_000`
(Prisma's 5s/2s defaults are far too tight for a 500-row multi-statement transaction), every
statement issued on the transaction handle, never on `jobPrisma`:**
1. `SELECT id, opportunity_id, expected_version FROM job_items WHERE job_id=$1 AND status='pending' AND next_attempt_at <= now() ORDER BY id LIMIT $chunk FOR UPDATE SKIP LOCKED`
   — throw here is **tier 1**: nothing claimed, nothing to penalise.
2. `SELECT id, stage_id, version FROM opportunities WHERE id = ANY($ids) ORDER BY id FOR UPDATE`
   — deterministic lock order, no deadlock; also supplies `from_stage_id`.
3. Partition in application code into **already-at-target** (`stage_id = target`, any version →
   `done`, no mutation, no version bump, no transition), **conflict**
   (`stage_id <> target AND version <> expected_version` → `skipped_conflict`), **apply**
   (`stage_id <> target AND version = expected_version`).
4. Apply bucket only: `UPDATE opportunities SET stage_id=$t, version=version+1, updated_at=now() WHERE id = ANY($applyIds)`
   (no version predicate needed — rows are locked and already verified), then insert the
   `transitions` rows with `job_id` set. Throw here is **tier 2**.
5. Mark `job_items` `done` / `skipped_conflict`. Commit.

`touchLastProgress` runs **after** the transaction commits, in its own statement — never inside
it. `recordChunkFailure` runs in a fresh transaction after rollback and is guarded with
`AND status='pending'` so it cannot penalise rows another loop already resolved.

**Picker:**
```sql
SELECT j.id FROM jobs j
WHERE j.status = 'running'
  AND EXISTS (SELECT 1 FROM job_items ji
              WHERE ji.job_id = j.id AND ji.status = 'pending' AND ji.next_attempt_at <= now())
ORDER BY j.last_progress_at ASC NULLS FIRST
LIMIT 1;
```

**Finalize sweep** — time-gated every `SWEEP_INTERVAL_MS` on *every* loop iteration regardless
of whether the picker returned a job, set-based across all drained running jobs, status choice
folded into the same statement (cast literals to `job_status`, since a bare CASE resolves to
`text`):
```sql
UPDATE jobs SET
  status = CASE WHEN EXISTS (SELECT 1 FROM job_items WHERE job_id = jobs.id AND status='failed')
                THEN 'failed'::job_status ELSE 'completed'::job_status END,
  error_message = (SELECT count(*) || ' item(s) failed after max attempts; see job_items.last_error'
                   FROM job_items WHERE job_id = jobs.id AND status='failed' HAVING count(*) > 0)
WHERE status = 'running'
  AND NOT EXISTS (SELECT 1 FROM job_items WHERE job_id = jobs.id AND status='pending');
```

**Steps:**
1. RED: `tests/part2/chunk.test.ts` — one job, fewer items than a chunk; call
   `claimAndApplyChunk` once; assert every item `done`, each opportunity at the target stage
   with `version` bumped exactly once, exactly one `transitions` row per opportunity with
   `job_id` set and the correct `from_stage_id`. Run. Expected: FAIL — module not found.
2. GREEN: implement steps 1–5 above plus `touchLastProgress`. Re-run. Expected: PASS.
3. RED: `tests/part2/alreadyAtTarget.test.ts` — an opportunity already in the target stage at
   snapshot time; run the chunk; assert `job_items` is `done`, `version` **unchanged**, and
   **zero** transitions rows for that opportunity. Run. Expected: FAIL (naive impl bumps
   version and writes an `X → X` transition).
4. GREEN: add the already-at-target bucket. Re-run. Expected: PASS, 3/3.
5. RED: `tests/part2/poisonChunk.test.ts` — force the apply to throw (a stub `jobPrisma` whose
   `UPDATE opportunities` rejects); assert `attempts` incremented, `next_attempt_at` moved into
   the future, item still `pending`; repeat past `MAX_ATTEMPTS` and assert the items become
   `failed` with `last_error` set and are never returned by the claim query again; then run
   the sweep and assert `jobs.status = 'failed'` with a non-null `error_message`, while the
   job's other items' `done` counts are untouched. Run. Expected: FAIL.
6. GREEN: implement `recordChunkFailure` (guarded), the `attempts`/backoff/terminal-`failed`
   logic, and `runFinalizeSweep`. Re-run. Expected: PASS.
7. RED: `tests/part2/drainedJobFinalizes.test.ts` — resolve every item of job A to `done`
   *without* calling the picker or a chunk, then call `runFinalizeSweep()` alone; assert A
   reaches `completed`. Second variant: a *second* job B with thousands of claimable items is
   also running, all loops are busy on B; assert A still finalizes within `2 × SWEEP_INTERVAL_MS`
   — this is the test that fails against idle-gated sweeping. Run. Expected: FAIL.
8. GREEN: time-gate the sweep in `runLoop` rather than idle-gating it. Re-run. Expected: PASS,
   both variants.
9. RED: `tests/part2/finalizeRace.test.ts` — variant 1: get a job to `pending = 0`, then insert
   a fresh `pending` item concurrently with the sweep; assert the job is never `completed`
   while a pending row exists. Variant 2: race `recordChunkFailure` marking the last item
   `failed` against the sweep; assert the job never lands `completed` with a non-zero `failed`
   count. Run. Expected: FAIL for a read-then-write implementation.
10. GREEN: the single atomic CASE statement above. Re-run. Expected: PASS, both variants.
11. RED: `tests/part2/picker.test.ts` — (a) a job whose remaining items are all backed off into
    the future is **not** returned by the picker, while a second job with claimable work is;
    (b) with two running jobs both claimable, repeated picks return the one with the older
    `last_progress_at` (no starvation). Run. Expected: FAIL.
12. GREEN: the picker query above. Re-run. Expected: PASS.
13. Commit `feat(worker): single-transaction claim+apply, poison retry, decoupled finalize sweep`.

**Test command:** `npx jest tests/part2/chunk.test.ts tests/part2/alreadyAtTarget.test.ts tests/part2/poisonChunk.test.ts tests/part2/drainedJobFinalizes.test.ts tests/part2/finalizeRace.test.ts tests/part2/picker.test.ts`

---

## Task 8: Resume correctness

**Goal.** Prove `job_items.status` really is the cursor: a partially-drained job resumes with
no double-apply and nothing dropped.

**Steps:**
1. RED: `tests/part2/resume.test.ts` — seed a job spanning ≥3 chunks; call
   `claimAndApplyChunk` twice (simulating a kill mid-job); assert a mixed `done`/`pending`
   state with `jobs.status` still `running`; drain the rest; assert **every** item `done`,
   every opportunity's `version` bumped **exactly once**, exactly one transition row each, and
   that one extra `claimAndApplyChunk` call after completion claims 0 rows and changes nothing.
   Run. Expected: FAIL — module not found.
2. GREEN: no production change expected; if the test fails against the Task 7 implementation,
   that is a real finding — debug with superpowers:systematic-debugging, do not weaken the test.
   Expected: PASS.
3. Commit `test(worker): resume correctness after a simulated mid-job kill`.

**Test command:** `npx jest tests/part2/resume.test.ts`

---

## Task 9: Collision policy — manual edit wins

**Steps:**
1. RED: `tests/part2/collision.test.ts` — snapshot a job; before the chunk runs, perform a
   manual move on one of its opportunities (bumping `version`); run the chunk; assert the final
   `stage_id` is the *manual* move's target, `version` reflects only the manual bump, the
   `job_items` row is `skipped_conflict`, and **no** transition row with this `job_id` exists
   for that opportunity. Run. Expected: FAIL until the manual-move path exists.
2. GREEN: this needs `opportunityService.moveOpportunity` (Task 14's single move) earlier than
   the design doc's commit order implies — implement the service function now (the HTTP route
   still lands in Task 14) so the collision test drives real production code rather than a raw
   UPDATE in the test. Re-run. Expected: PASS.
3. Commit `feat(api): single-move service with optimistic version guard; test(worker): collision policy`.

**Test command:** `npx jest tests/part2/collision.test.ts`

---

## Task 10: Concurrent loops — the highest-value test

**Goal.** Prove the single-transaction claim+apply boundary. With zero manual edits, any
`skipped_conflict` is definitionally a false conflict manufactured by the concurrency
mechanism.

**Steps:**
1. RED: `tests/part2/concurrentLoops.test.ts` — seed a job with ~2500 matching items (≥5
   chunks at `CHUNK_SIZE=500`); run `WORKER_POOL_SIZE` (3) concurrent loop-equivalents against
   it with **no** manual edits anywhere; drain to completion. Assert: every `job_items` row is
   `done` and **zero** are `skipped_conflict`; exactly one transition row per opportunity
   (neither zero nor two); every opportunity's `version` incremented exactly once.
   Run. Expected: PASS against Task 7's single-transaction design. If it fails, a real
   concurrency bug exists — debug, do not relax the assertions.
2. Additionally prove the test has teeth: temporarily split claim and apply into two
   transactions, re-run, confirm it fails loudly, then revert the split. Expected: the split
   version reports non-zero `skipped_conflict`. Record the observed number in the ledger.
3. Commit `test(worker): concurrent-loop correctness proof for the claim/apply transaction boundary`.

**Test command:** `npx jest tests/part2/concurrentLoops.test.ts`

---

## Task 11: Progress endpoint and retry-failed endpoint

**Interfaces — Produces:**
- `GET /jobs/:id` → `{ id, status, totalCount, matchedCount, truncated, counts: { done, pending, skippedConflict, failed }, backedOff, lastProgressAt, errorMessage, classification }`
  where `classification` is `running | backing_off | stuck | completed | failed`, derived per
  the design doc's three-way rule using the `backedOff` aggregate.
- `POST /jobs/:id/retry-failed` → flips this job's `failed` items back to `pending`
  (`attempts=0`, `next_attempt_at=now()`, `last_error=NULL`) and `jobs.status` back to
  `running`, in one transaction; no `Idempotency-Key` (a second call is a 0-row no-op).

**Steps:**
1. RED: `tests/part2/progress.test.ts` — mixed `done`/`pending`/`skipped_conflict`/`failed`
   state; assert the counts match committed rows exactly; assert `backedOff` counts only
   pending items with `next_attempt_at > now()`; assert `classification` is `backing_off` when
   `backedOff === pending > 0` and `stuck` when `backedOff < pending` with a stale
   `last_progress_at`. Run. Expected: FAIL.
2. GREEN: one query — `GROUP BY status` plus the
   `count(*) FILTER (WHERE status='pending' AND next_attempt_at > now())` aggregate, joined to
   `jobs`. Re-run. Expected: PASS.
3. RED: `tests/part2/retryFailed.test.ts` — drive items to `failed`; `POST /jobs/:id/retry-failed`;
   assert they return to `pending` with `attempts=0` and `jobs.status='running'`; drain and
   assert completion. Variant: a manual edit landed on one of those opportunities while it sat
   `failed` — assert replay resolves it as `skipped_conflict`, **not** a force-apply, proving
   `expected_version` was left untouched by the replay. Variant: calling retry-failed twice is a
   harmless no-op. Run. Expected: FAIL.
4. GREEN: implement the endpoint. Re-run. Expected: PASS, 3 variants.
5. Commit `feat(api): progress endpoint with honest stuck classification, and retry-failed replay`.

**Test command:** `npx jest tests/part2/progress.test.ts tests/part2/retryFailed.test.ts`

---

## Task 12: Isolation and snapshot semantics

**Steps:**
1. RED: `tests/part2/isolation.test.ts` — run a bulk job in workspace A to completion; assert
   zero opportunities, `job_items` or `transitions` in workspace B were created or modified
   (compare a full before/after snapshot of B's rows including `updated_at` and `version`).
   Run. Expected: FAIL — module not found.
2. RED: `tests/part2/snapshot.test.ts` — an opportunity that does **not** match the filter at
   submission is edited afterwards so that it *would* match; run the job to completion; assert
   it is untouched (no `job_items` row, no transition, `version` unchanged). And the converse:
   an opportunity that matched at submission but is edited to stop matching is **still** moved
   (selection is final) — unless a version bump makes it a conflict, in which case
   `skipped_conflict`. Run. Expected: FAIL.
3. GREEN: expect no production change; any failure is a real finding.
   Expected: PASS for both files.
4. Commit `test(worker): workspace isolation and snapshot-not-live-set semantics`.

**Test command:** `npx jest tests/part2/isolation.test.ts tests/part2/snapshot.test.ts`

---

## Task 13: Part 1 endpoints

**Interfaces — Produces:** `POST /opportunities` (201, `version=1`);
`POST /opportunities/:id/move` (`{ targetStageId, expectedVersion? }`, 409 on mismatch, 400 on
cross-workspace or cross-pipeline stage, writes a `transitions` row with `job_id = NULL`);
`GET /stages/:stageId/opportunities?cursor=&limit=` (keyset on `(created_at, id)`, opaque
base64 cursor).

**Steps:**
1. RED: `tests/part1/opportunities.test.ts` — create returns 201 with `version=1`; move bumps
   version and writes a transition; move with a stale `expectedVersion` → 409 and no mutation;
   a full paginated walk over ≥250 rows with `limit=100` yields every row exactly once, no
   duplicates and no gaps, including across rows that share a `created_at` (which is why the
   cursor carries `id` too). Run. Expected: FAIL.
2. RED: `tests/part1/crossTenantStage.test.ts` and `tests/part1/crossPipelineStage.test.ts` —
   single move to a stage in another workspace → 400, nothing changed; single move to a stage
   in a different pipeline of the same workspace → 400, `pipeline_id`/`stage_id` unchanged.
   Run. Expected: FAIL.
3. GREEN: implement the three routes on top of Task 9's `opportunityService`. Re-run both
   files. Expected: PASS.
4. Commit `feat(api): part 1 CRUD, single move and keyset-paginated stage listing`.

**Test command:** `npx jest tests/part1`

---

## Task 14: Full-scale seed

**Steps:**
1. Run `npm run seed -- --large` against the dev database: one 500 000-row workspace with the
   12-stage funnel plus 5 small workspaces of 2 000–5 000 rows each. Expected: completes, and
   `SELECT count(*)` confirms the totals; `ANALYZE` ran.
2. Time it and record the wall clock in the ledger. Expected: minutes, not hours — if it is
   hours, the seed is not set-based and that is a finding.
3. Commit `feat(seed): large-scale benchmark dataset flag`.

**Test command:** `npx jest tests/db/seed.test.ts`

---

## Task 15: docker-compose topology

**Goal.** One file, one command. `docker compose up` brings up `postgres` + `postgres-test`,
migrates, seeds a small demo dataset, starts `api` and `worker`, and runs the Jest suite in a
`test` service whose logs stream inline — without `--abort-on-container-exit`, so `api` and
`worker` keep running after tests finish.

**Interfaces — Produces:** `Dockerfile` (one image; the service is selected by compose
`command:`), `docker-compose.yml` with services `postgres`, `postgres-test`, `migrate`, `seed`,
`api`, `worker`, `test`, with health checks and `depends_on: condition: service_healthy`.

**Steps:**
1. Write the `Dockerfile` and `docker-compose.yml`.
2. `podman compose -f docker-compose.yml config` — Expected: parses, prints the resolved model,
   exit 0.
3. `podman compose up --build` — Expected: `migrate` and `seed` exit 0; `test` runs the suite
   and exits 0; `api` and `worker` are still running afterwards. Capture the combined log tail.
   If podman-specific issues block a full run, record exactly what failed in the ledger as a
   ruling rather than silently claiming the stack works.
4. Commit `feat(docker): single-file compose topology running app and tests in one command`.

**Test command:** `podman compose -f docker-compose.yml config`

---

## Task 16: Real-process kill/resume integration test

**Steps:**
1. RED: `tests/integration/killResume.test.ts` — submit a job with several thousand items;
   spawn `src/worker/index.ts` as a child process; poll until a meaningful fraction is `done`;
   `SIGKILL` it; assert `last_progress_at` stops advancing and the remaining items are still
   `pending` (nothing stuck in a limbo status); spawn a fresh worker; poll to completion;
   assert zero double-applies via
   `SELECT opportunity_id FROM transitions WHERE job_id=$1 GROUP BY opportunity_id HAVING count(*) > 1`
   returning no rows, and `pending = 0`. Run. Expected: FAIL initially if the worker entrypoint
   is not spawnable standalone.
2. GREEN: make `src/worker/index.ts` runnable via `ts-node` with env passed through.
   Re-run. Expected: PASS.
3. Commit `test(integration): real-process kill and resume correctness`.

**Test command:** `npx jest tests/integration/killResume.test.ts`

---

## Task 17: Benchmark scripts

**Interfaces — Produces:** `scripts/benchmark/bulkMove.ts`, `interactiveLoad.ts`,
`killResume.ts`, `report.ts`; npm script `bench:all`; JSON results under `bench-results/`.

**Steps:**
1. `bulkMove.ts` — submit a ~50 000-row filter, poll every 500 ms, report wall clock,
   items/sec, and a bucketed throughput timeseries (steady vs degrading). Separately time the
   `POST /jobs/bulk-move` request itself for **two** filter shapes: (a) stage-only, (b) broad
   (`status` + `valueMin`, no stage/owner narrowing). Report the two submission latencies
   separately.
2. `interactiveLoad.ts` — steady-rate create/move/list against the *same* workspace as a
   running bulk job, and against a *different* small workspace, plus a no-job baseline for
   both; report p95/p99 and the delta from baseline.
3. `killResume.ts` — the benchmark variant of Task 16 using container kill, reporting
   kill-to-completion time plus the double-apply and dropped-item proofs.
4. `report.ts` — collate the JSON into `BENCHMARKS.md` tables, including a hardware block from
   `os.cpus()` / `os.totalmem()` / `os.release()`. Numbers are generated, never hand-typed.
5. Run `npm run bench:all` against the large-seeded stack. Expected: JSON written for all three;
   `BENCHMARKS.md` regenerated.
6. Commit `feat(bench): bulk-move, interactive-load and kill-resume benchmarks with generated report`.

**Test command:** `npx tsc --noEmit -p tsconfig.json`

---

## Task 18: DESIGN.md, BENCHMARKS.md, README.md

**Goal.** Written last, describing measured behaviour rather than intended behaviour.

**DESIGN.md must contain all seven sections as separate headings:**
1. Chunking + cursor-restart mechanism + the index that makes chunking cheap.
2. Idempotency model: key, storage, what it protects, and the gap where a retry still slips
   through (client minting a fresh key per retry).
3. Concurrency control on a single opportunity, and what happens when a manual move and the job
   hit the same record.
4. Snapshot vs live filter set, and the consequence of the choice.
5. Isolation mechanism and the hole it leaves (two workspaces' jobs contend for the same small
   `jobPrisma` pool).
6. **What breaks at 10×** — a 500 000-record move against 20M opportunities, naming the first
   thing to fail (the synchronous snapshot `INSERT…SELECT` on the request path), then (b)
   `job_items` growth and progress-query cost, then (c) the single-worker throughput ceiling.
7. **What I'd do with another week, ranked.**

Plus, explicitly: the NestJS deviation, and the honest weak spots — including the measured
broad-filter submission latency from Task 17.

**README.md** carries the run/seed/test instructions and a verbatim implemented /
not-implemented list drawn from the design doc's Explicit Exclusions.

**Steps:**
1. Write `BENCHMARKS.md` via `npm run bench:report` (generated numbers).
   Expected: tables contain real measured values, no placeholders.
2. Write `DESIGN.md` with all 7 headings. Expected: `grep -c '^## '` ≥ 7 and each of the seven
   topics is present.
3. Write `README.md`. Expected: the documented one command is `docker compose up`.
4. Commit `docs: DESIGN.md (7 sections), generated BENCHMARKS.md, README.md`.

**Test command:** `npx jest`

---

## Review Focus

Input classes and failure modes the tests above do **not** exercise, for the final reviewer to
check deliberately:

- A filter whose predicate matches **zero** rows: does submission return a 202 with
  `totalCount: 0`, and does the finalize sweep immediately complete a job with no items? (A
  job with zero `job_items` satisfies `NOT EXISTS (pending)` trivially — confirm it finalizes
  `completed` rather than hanging `running`, and that it isn't finalized *before* the snapshot
  insert commits.)
- `Idempotency-Key` absent entirely, empty string, or absurdly long.
- A `filter` containing unexpected keys, or `valueMin > valueMax`, or non-ISO dates.
- Numeric precision: `value numeric(14,2)` crossing the Prisma `Decimal` boundary in filter
  comparisons.
- `BigInt` serialization of `job_items.id` if it ever reaches a JSON response.
- The worker's behaviour when `jobPrisma`'s pool is exhausted because all 3 loops are mid-chunk
  and the sweep also wants a connection — does the sweep block past `SWEEP_INTERVAL_MS`?
- Clock skew between `next_attempt_at` computed in Node vs `now()` evaluated in Postgres.
- Graceful `SIGTERM` during an in-flight chunk: does the transaction roll back cleanly and
  leave items `pending` rather than half-applied?
