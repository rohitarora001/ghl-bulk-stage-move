# Bulk pipeline-stage move

GoHighLevel SDE-3 take-home. Moves up to 50 000 CRM opportunities to a new pipeline stage through a
background job that is idempotent, resumable after a kill, observable from committed state, correct
when a human edits a record the job is also touching, and isolated per tenant.

- **[DESIGN.md](DESIGN.md)** — how it works, what was measured, and where it is weak.
- **[BENCHMARKS.md](BENCHMARKS.md)** — generated from real runs, not written by hand.

Node.js 22 · TypeScript 5.9 · Express 5 · Prisma 6 · PostgreSQL 16. **Express, not NestJS** — a
documented deviation, see [DESIGN.md](DESIGN.md#stack-express-not-nestjs).

## One command

```bash
docker compose up
```

That brings up both databases, runs the role/migration/grant chain, seeds a small demo dataset,
starts `api` and `worker`, and runs the full Jest suite against a separate test database. Ordering
is enforced by health checks and `service_completed_successfully`, never by sleeps.

| Service | What it does | Exits? |
|---|---|---|
| `postgres` | application database, `localhost:55432` | no |
| `postgres-test` | throwaway database for the suite, `localhost:55433` | no |
| `migrate` | roles → Prisma migrations → grants | yes (0) |
| `seed` | 5 000 + 2×2 000 opportunities, `--reset` first | yes (0) |
| `api` | Express on `localhost:3000` | no |
| `worker` | 3 claim loops + finalize sweep | no |
| `test` | `jest --runInBand` against `postgres-test` | yes (0) |

The suite's result is its exit code:

```bash
docker compose ps -a          # test → Exited (0)
docker compose logs test      # Test Suites: 26 passed, Tests: 94 passed
```

`api` and `worker` deliberately stay up after the tests finish — the brief is "one command brings up
the app **and** runs the suite", and a stack that tears itself down the moment the tests pass has
only done half of it.

## Running it by hand

```bash
npm install
docker compose up -d postgres postgres-test

export DATABASE_URL_ADMIN='postgresql://postgres:postgres@localhost:55432/ghl'
export DATABASE_URL_INTERACTIVE='postgresql://app_interactive:app_interactive@localhost:55432/ghl?connection_limit=15'
export DATABASE_URL_WORKER='postgresql://app_worker:app_worker@localhost:55432/ghl?connection_limit=3'

npm run migrate          # roles, migrations, grants — idempotent, safe to re-run
npm run seed -- --reset  # small demo dataset; prints the workspace ids it created
npm run dev              # api + worker in one terminal
```

`DATABASE_URL_WORKER` **must** carry an explicit `connection_limit`: it is the isolation mechanism,
and boot refuses to start without it, or if `WORKER_POOL_SIZE` exceeds it.

### Tests

```bash
export DATABASE_URL_ADMIN='postgresql://postgres:postgres@localhost:55433/ghl_test'
export DATABASE_URL_INTERACTIVE='postgresql://app_interactive:app_interactive@localhost:55433/ghl_test?connection_limit=15'
export DATABASE_URL_WORKER='postgresql://app_worker:app_worker@localhost:55433/ghl_test?connection_limit=3'
npm test
```

26 suites / 94 tests. They truncate every table between cases, so point them at `ghl_test` — never
at a database holding a dataset you want to keep.

### Benchmarks

```bash
createdb ghl_dev   # or: docker compose exec postgres-test createdb -U postgres ghl_dev
DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:55433/ghl_dev npm run migrate
DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:55433/ghl_dev npm run seed -- --large
npm run bench:all
```

`--large` seeds 500 000 opportunities across 12 stages plus five small neighbour workspaces (~41 s).
`bench:all` runs the three benchmarks — each starting the real `api` and `worker` entrypoints as
separate OS processes — and regenerates `BENCHMARKS.md` from the JSON they leave in `bench-results/`.

## API

Every request carries `X-Workspace-Id`. There is no auth (see exclusions below); the header is
validated against the `workspaces` table, and another tenant's row answers 404, never 403.

| Method | Path | |
|---|---|---|
| POST | `/opportunities` | create |
| POST | `/opportunities/:id/move` | single manual move; bumps `version` |
| GET | `/stages/:stageId/opportunities` | keyset-paginated list (`?limit=&cursor=`) |
| POST | `/jobs/bulk-move` | submit a bulk move → `202` |
| GET | `/jobs/:id` | progress from committed state |
| POST | `/jobs/:id/retry-failed` | re-enqueue items that exhausted their retries |
| GET | `/health` | liveness |

### Walking through a bulk move

```bash
# Ids come from the seed output; or read them straight out of the database:
#   select w.id as workspace, s.id as stage, s.name from workspaces w join stages s
#   on s.workspace_id = w.id order by w.created_at, s.position;
WS=<workspace-id>; SRC=<source-stage-id>; DST=<target-stage-id>

curl -s -X POST localhost:3000/jobs/bulk-move \
  -H "X-Workspace-Id: $WS" -H 'Idempotency-Key: demo-1' -H 'Content-Type: application/json' \
  -d "{\"filter\":{\"stageId\":\"$SRC\",\"status\":\"open\"},\"targetStageId\":\"$DST\"}"
# → 202 {"jobId":"...","totalCount":3170,"matchedCount":3170,"truncated":false}

curl -s localhost:3000/jobs/<jobId> -H "X-Workspace-Id: $WS"
# → {"status":"running","counts":{"done":1500,"pending":1670,"skippedConflict":0,"failed":0},
#    "backedOff":0,"classification":"running", ...}
```

Replaying the same `Idempotency-Key` returns the same `jobId` without enrolling anything a second
time. `matchedCount` is `null` when `truncated` is true: the snapshot deliberately stops counting at
`BULK_MAX_ITEMS`, so the honest answer to "how many matched?" is "unknown".

To watch resume work, kill the worker mid-job and restart it:

```bash
docker compose kill worker     # progress freezes; counts stay consistent
docker compose start worker    # the job drains to completion, nothing applied twice
```

### Configuration

All optional except the three database URLs. Parsed and validated at boot (`src/shared/config.ts`).

| Variable | Default | |
|---|---:|---|
| `PORT` | 3000 | api |
| `CHUNK_SIZE` | 500 | items per claim+apply transaction |
| `BULK_MAX_ITEMS` | 50000 | enrolment cap; beyond it, `truncated: true` |
| `WORKER_POOL_SIZE` | 3 | claim loops; must be ≤ the worker `connection_limit` |
| `MAX_ATTEMPTS` | 5 | retries before an item is `failed` |
| `SWEEP_INTERVAL_MS` | 2000 | finalize sweep rate limit, process-wide |
| `IDLE_BACKOFF_MS` | 250 | sleep when nothing is claimable |
| `CLAIM_BACKOFF_MS` | 500 | sleep after a claim-level error |
| `STUCK_AFTER_MS` | 60000 | staleness before `classification: "stuck"` |

## What is implemented

- Part 1: create an opportunity, move one by hand, list a stage with keyset pagination.
- Part 2: `POST /jobs/bulk-move` with a snapshot of the match set, client-facing idempotency on
  `(workspace_id, idempotency_key)`, and truncation reporting at the 50 000 cap.
- A worker of N concurrent claim loops using `FOR UPDATE SKIP LOCKED`, one transaction per chunk,
  deterministic lock ordering, per-item exponential backoff, terminal `failed` after `MAX_ATTEMPTS`,
  and an atomic time-gated finalize sweep.
- Optimistic concurrency against manual edits (`version` / `expected_version`): the manual edit wins
  and the item is reported as `skipped_conflict`.
- A partial unique index on `transitions (job_id, opportunity_id)` making double-apply structurally
  impossible, not merely detectable.
- `GET /jobs/:id` computed from committed rows every call, classifying
  `running | backing_off | stuck | completed | failed`, and `POST /jobs/:id/retry-failed`.
- Tenant isolation: workspace-leading indexes, two Postgres roles with role-level statement
  timeouts, and two connection pools whose worker-side `connection_limit=3` is the actual mechanism.
- 26 test suites / 94 tests, including a real-process SIGKILL-and-resume integration test, and three
  benchmarks that measure the shipped entrypoints as separate processes.

## What is not implemented

Copied from the design's Explicit Exclusions, verbatim:

> No board/pipeline summary or per-stage rollup endpoint. No rich filtering/sorting beyond the bulk
> filter's own fields. No auth/JWT/permissions. No webhook/event emission on transitions. No
> custom-fields/contacts/notes/tasks. No CI/K8s config. No exhaustive validation/error-code taxonomy
> beyond the two cheap, correctness-critical checks kept in scope (target-stage workspace ownership;
> filter-match truncation reporting). No horizontal/multi-machine worker scaling (SKIP LOCKED makes
> it *safe* if scaled, but no leader-election or distributed coordination is built, since grading is
> single-box) — named explicitly as the first "breaks at 10x" candidate above, not silently absent.

[DESIGN.md](DESIGN.md#honest-weak-spots) adds the weak spots that are not absences but measured
limitations of what *is* built.

## Layout

```
src/api/        Express app, routes, services (submission, progress, retry, part 1)
src/worker/     claim loops, claimAndApplyChunk, picker/sweep/backoff queries
src/db/         the two Prisma clients and their pools
src/shared/     config parsing, logger
prisma/         schema, migrations (partial indexes hand-added), roles + grants SQL
scripts/        migrate, seed, benchmark/
tests/          db, part1, part2, integration, unit
```
