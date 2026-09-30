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
| `worker` | 3 claim loops + a finalize sweeper on its own connection | no |
| `test` | `jest --runInBand` against `postgres-test` | yes (0) |

The suite's result is its exit code:

```bash
docker compose ps -a          # test → Exited (0)
docker compose logs test      # Test Suites: 32 passed, Tests: 129 passed
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
and boot refuses to start without it, or if `WORKER_POOL_SIZE` exceeds it. The worker process opens
that many connections for its claim loops plus one more for the finalize sweeper, which is pinned to
a pool of one so it never queues behind a chunk.

### Tests

```bash
export DATABASE_URL_ADMIN='postgresql://postgres:postgres@localhost:55433/ghl_test'
export DATABASE_URL_INTERACTIVE='postgresql://app_interactive:app_interactive@localhost:55433/ghl_test?connection_limit=15'
export DATABASE_URL_WORKER='postgresql://app_worker:app_worker@localhost:55433/ghl_test?connection_limit=3'
npm test
```

32 suites / 129 tests — 103 against real Postgres, 26 service unit tests against fake
repositories. The Postgres ones truncate every table between cases, so point them at `ghl_test` — never
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
| POST | `/jobs/bulk-move` | submit a bulk move → `202`; a replayed `Idempotency-Key` → `200` with the original job, the same key with a different request → `409` |
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

All optional except the three database URLs. Parsed and validated at boot (`src/config/env.ts`).

| Variable | Default | |
|---|---:|---|
| `PORT` | 3000 | api |
| `CHUNK_SIZE` | 500 | items per claim+apply transaction |
| `BULK_MAX_ITEMS` | 50000 | enrolment cap; beyond it, `truncated: true` |
| `WORKER_POOL_SIZE` | 3 | claim loops; must be ≤ the worker `connection_limit` |
| `MAX_ATTEMPTS` | 5 | retries before an item is `failed` |
| `SWEEP_INTERVAL_MS` | 2000 | how often the sweeper finalizes drained jobs; it runs on its own timer and its own connection, never inside a claim loop |
| `IDLE_BACKOFF_MS` | 250 | sleep when nothing is claimable |
| `CLAIM_BACKOFF_MS` | 500 | sleep after a claim-level error |
| `STUCK_AFTER_MS` | 60000 | staleness before `classification: "stuck"` |

## What is implemented

- Part 1: create an opportunity, move one by hand, list a stage with keyset pagination.
- Part 2: `POST /jobs/bulk-move` with a snapshot of the match set, client-facing idempotency on
  `(workspace_id, idempotency_key)` — including a request fingerprint, so one key reused for a
  different filter or target stage is a `409` rather than a silently wrong `200` — and truncation
  reporting at the 50 000 cap.
- A worker of N concurrent claim loops using `FOR UPDATE SKIP LOCKED`, one transaction per chunk,
  deterministic lock ordering, per-item exponential backoff, terminal `failed` after `MAX_ATTEMPTS`,
  and an atomic finalize sweeper on its own timer and connection. An apply failure isolates itself:
  the chunk is re-run one item per transaction, so only the row that actually fails is penalised.
- Optimistic concurrency against manual edits (`version` / `expected_version`): the manual edit wins
  and the item is reported as `skipped_conflict`.
- A partial unique index on `transitions (job_id, opportunity_id)` making double-apply structurally
  impossible, not merely detectable.
- `GET /jobs/:id` computed from committed rows every call, classifying
  `running | backing_off | stuck | completed | failed`, and `POST /jobs/:id/retry-failed`.
- Tenant isolation: workspace-leading indexes, two Postgres roles with role-level statement
  timeouts, and two connection pools whose worker-side `connection_limit=3` is the actual mechanism.
- 32 test suites / 129 tests, including a real-process SIGKILL-and-resume integration test, an
  `EXPLAIN`-reading test that pins the claim query's index, and three benchmarks that measure the
  shipped entrypoints as separate processes.

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

## Architecture

Feature modules with strict layering. Dependencies point inward only, and the two rules that are
easiest to break — a service reaching for Prisma, a controller reaching past its service — are
enforced by ESLint rather than by review.

```mermaid
flowchart TD
    subgraph entry["src/app — composition root"]
        server["server.ts<br/>HTTP entrypoint"]
        worker["worker.ts<br/>claim loops + sweeper"]
        createApp["createApp.ts"]
        container["container.ts<br/>manual DI"]
    end

    subgraph modules["src/modules — features"]
        routes["*.routes.ts<br/>paths + validation"]
        controller["*.controller.ts<br/>HTTP in/out"]
        service["*.service.ts<br/>business rules"]
        repository["*.repository.ts<br/>Prisma + SQL"]
        processor["jobs/*.processor.ts<br/>one unit of background work"]
    end

    subgraph shared["src/shared — cross-cutting"]
        middleware["middleware<br/>requestId, workspaceScope,<br/>validate, notFound, errorHandler"]
        errors["errors<br/>AppError + ERROR_CODE"]
        database["database<br/>3 pooled clients, withTransaction"]
        runtime["worker-runtime<br/>pollingLoop, sleep"]
    end

    config["src/config — the only reader of process.env"]
    registry["src/jobs/registry.ts<br/>job kind → processor"]
    db[("PostgreSQL")]

    server --> createApp --> routes --> controller --> service --> repository --> db
    createApp --> middleware
    worker --> registry --> processor --> service
    worker --> runtime
    container -.builds.-> service
    container -.builds.-> repository
    service --> errors
    repository --> database --> db
    modules --> config
    shared --> config
```

### Where things live

| Question | Answer |
|---|---|
| Where is the endpoint for X? | `modules/<feature>/<feature>.routes.ts` |
| Where is the business rule for Y? | `modules/<feature>/<feature>.service.ts` |
| Where is the DB query for Z? | `modules/<feature>/<feature>.repository.ts` |
| Where is job J processed? | `modules/<feature>/jobs/<job>.processor.ts`, listed in `jobs/registry.ts` |
| Where are env vars defined? | `config/env.ts` — nothing else reads `process.env` |
| Where does an error become a response? | `shared/middleware/errorHandler.ts` — the only place |

```
src/
├── app/                    composition root: createApp, server, worker, container
├── config/                 env schema + typed config (the only process.env reader)
├── jobs/registry.ts        job kind → processor
├── modules/
│   ├── bulk-move/          submission, progress, retry + jobs/ (claim, sweep)
│   ├── opportunities/      create, single move, keyset listing
│   └── workspaces/         workspace lookup behind the tenant scope
└── shared/                 database, errors, http, logger, middleware, types, utils,
                            worker-runtime
prisma/                     schema, migrations (partial indexes hand-added), roles + grants
scripts/                    migrate, seed, benchmark/
tests/                      db, part1, part2, integration — everything that needs real Postgres
```

Service unit tests live beside the code they test, in `modules/*/__tests__/`, and run against fake
repositories with no database. Anything that needs real Postgres — and most of this system's
interesting behaviour does — stays under `tests/`.

### Layer rules

| Layer | May use | Must not |
|---|---|---|
| Routes | path, method, middleware, controller binding | any logic |
| Controller | validated input, service calls, response shaping | business rules, Prisma, try/catch |
| Service | rules, orchestration, transaction boundaries, repositories | `req`/`res`, Express, Prisma |
| Repository | Prisma, SQL, row mapping | business rules, HTTP |
| Processor | deserialise work, call a service, decide the retry cadence | business logic, Prisma |
| Middleware | cross-cutting concerns | feature-specific logic |

`eslint.config.mjs` enforces the forbidden column: `shared/` and `config/` cannot import a module,
a module cannot import the composition root, `*.service.ts` cannot import `@prisma/client` or
`express`, and `*.controller.ts` cannot import a repository. `import/no-cycle` bans circular
imports outright.

### Request lifecycle

```
requestId → express.json(1mb) → [/health] → workspaceScope → validate(schema) → controller
  → service (rules, transaction boundary) → repository (SQL) → PostgreSQL
  ← controller shapes status + JSON
  ✗ anything thrown → errorHandler → { error: { code, message, details? } }
```

`workspaceScope` is the only place `X-Workspace-Id` is read; handlers see `req.workspaceId`.
`validate()` parks parsed input on `req.validated`, so a handler reading `req.body` directly is
visible in review. Services and repositories throw; only `errorHandler` writes a status code.

### Job lifecycle

```
POST /jobs/bulk-move
  → one transaction: INSERT jobs + INSERT INTO job_items SELECT … (the snapshot)
                     the filter is stored but never re-evaluated

worker (src/app/worker.ts)
  ├─ N × claim loop        pickJob → processChunk → touchProgress
  │     processChunk       BEGIN; claim <= CHUNK_SIZE items FOR UPDATE SKIP LOCKED;
  │                        lock their opportunities ORDER BY id; apply; mark done /
  │                        skipped_conflict; COMMIT
  │     on apply failure   re-run the same items one per transaction, so only the row that
  │                        actually fails is penalised
  └─ 1 × finalize sweeper  own timer, own connection: marks drained jobs completed / failed
```

`job_items.status` is the cursor — there is no persisted offset to drift. A killed worker rolls
back to `pending`, and a partial unique index on `transitions (job_id, opportunity_id)` makes a
double-apply structurally impossible.

### Adding a module

1. `src/modules/<feature>/` with `<feature>.{routes,controller,service,repository,schemas,types,errors,constants}.ts`.
2. Repository first: intent-named methods over Prisma, returning domain shapes. It is the only
   file in the module allowed to import `@prisma/client`.
3. Service over the repository, taking it as a factory parameter. Throw the module's own errors;
   never touch `req`/`res`.
4. Controller: read `validated<T>(req, source)`, call the service, set status and JSON.
5. Routes: `validate(schema, source, { code, message })` per input, then the controller handler.
6. Wire it in `app/container.ts` and mount it in `app/createApp.ts`.
7. Unit-test the service against a fake repository in `__tests__/`; integration-test the routes
   under `tests/`.

Background work adds `jobs/<job>.processor.ts` and one line in `jobs/registry.ts`.

### Error codes

Every error response is `{ "error": { "code", "message", "details"? } }`. `details` carries zod's
issue list for body and query validation.

| Code | Status | Means |
|---|---:|---|
| `workspace_required` | 400 | no `X-Workspace-Id` header |
| `workspace_invalid` | 400 | header is not a uuid |
| `workspace_unknown` | 400 | no such workspace (400, not 404, so ids cannot be enumerated) |
| `invalid_json` | 400 | body is not valid JSON |
| `invalid_body` | 400 | body failed its schema |
| `invalid_query` | 400 | query parameters failed their schema |
| `invalid_cursor` | 400 | pagination cursor did not decode |
| `invalid_job_id` / `invalid_opportunity_id` / `invalid_stage_id` | 400 | path id is not a uuid |
| `idempotency_key_required` | 400 | submission without the header |
| `idempotency_key_invalid` | 400 | key longer than 255 characters |
| `invalid_stage` | 400 | stage is not in this workspace and the named pipeline |
| `invalid_target_stage` | 400 | move target is outside the record's pipeline |
| `target_stage_invalid` | 400 | bulk target is not a stage of this workspace |
| `filter_stage_invalid` | 400 | `filter.stageId` is not a stage of this workspace |
| `cross_pipeline_move` | 400 | source and target stages are in different pipelines |
| `not_found` | 404 | no such route |
| `job_not_found` / `opportunity_not_found` / `stage_not_found` | 404 | no such row in this workspace |
| `version_conflict` | 409 | `expectedVersion` is stale; `details` carries both versions |
| `idempotency_key_conflict` | 409 | key reused for a different filter or target stage |
| `payload_too_large` | 413 | body over 1mb |
| `internal_error` | 500 | unplanned; the detail is in the logs, never in the response |

### Conventions

- `camelCase` values, `PascalCase` types and classes, `SCREAMING_SNAKE` constants,
  `feature.role.ts` filenames.
- Comments explain **why**. What the code does is the code's job.
- Every service method carries a TSDoc header naming what it throws.
- No magic values: statuses, error codes, limits and headers are constants.
- Dependencies are injected through factory parameters; the only module-level singletons are the
  Prisma clients in `shared/database`, and they are lazy.
