# REFACTOR_NOTES.md

Living record of the architectural refactor of `ghl-bulk-stage-move`. Phase 0 is an audit only:
nothing in `src/`, `prisma/`, or `tests/` changed to produce it.

**Contract for the whole refactor:** zero behavior change. Same routes, same request and response
shapes, same status codes, same error envelope, same DB schema, same env vars, same worker
semantics. Structure, naming, layering, and tooling change; observable behavior does not.

---

## 1. Current structure map

```
src/
├── api/
│   ├── index.ts                     entrypoint: listen(), SIGTERM/SIGINT drain
│   ├── server.ts                    createApp(): json parser, /health, middleware, routers, 404, error handler
│   ├── errors.ts                    ApiError (status, code, message, details) + badRequest/notFound/conflict
│   ├── schemas.ts                   every zod schema for both features, one file
│   ├── middleware/workspaceScope.ts X-Workspace-Id → req.workspaceId (validated against the DB)
│   ├── routes/jobs.ts               3 routes + header checks + validation + response shaping
│   ├── routes/opportunities.ts      3 routes + validation + response shaping
│   └── services/
│       ├── jobService.ts            290 lines: fingerprint, snapshot CTE, idempotency, raw SQL
│       ├── opportunityService.ts    create + single move (locked read, version bump, transition)
│       ├── progressService.ts       progress aggregate + classification
│       ├── retryService.ts          retry-failed (reset items + job status)
│       └── stageListService.ts      keyset pagination, raw SQL, MAX_PAGE_SIZE
├── db/prismaClients.ts              3 lazy Prisma clients (interactive, job, sweep) + disconnectAll
├── shared/
│   ├── config.ts                    zod env schema, getConfig()/loadConfig()/resetConfigCache()
│   └── logger.ts                    dependency-free JSON-lines logger, LOG_LEVEL
└── worker/
    ├── index.ts                     runLoop, runSweepLoop, startWorker, entrypoint + shutdown
    ├── claimAndApplyChunk.ts        claim+apply transaction, isolation pass
    └── queries.ts                   picker, touchLastProgress, recordChunkFailure, runFinalizeSweep
scripts/                             migrate, seed, benchmark/ (5 files)
tests/                               db, part1, part2, integration, unit, setup — 30 suites / 103 tests
```

No circular imports (verified by reading every relative import in `src/`). Dependency direction is
already inward-ish: `api/*` → `db`, `shared`; `worker/*` → `db`, `shared`. Nothing imports `api`
from `worker` or the reverse.

### Request flow, end to end

```
HTTP → express.json({limit:'1mb'})
     → [/health short-circuits]
     → workspaceScope()          header present? uuid-shaped? exists in workspaces? → req.workspaceId
     → jobsRouter / opportunitiesRouter
         route handler: reads headers, safeParse(params), safeParse(body), safeParse(query),
                        calls service, .then(shape response).catch(next)
     → service: business rules + raw SQL/Prisma calls against a module-level client singleton
     → 404 catch-all
     → error handler: ApiError → {error:{code,message,details}}; SyntaxError → 400 invalid_json;
                      entity.too.large → 413 payload_too_large; anything else → log + 500
```

### Job flow, end to end

There is **no queue library**. The queue is the `job_items` table; `status` is the cursor.

```
POST /jobs/bulk-move → jobService.submitBulkMoveJob
                       → one transaction: insert `jobs` row + snapshot INSERT…SELECT into `job_items`
worker process (startWorker)
  ├── N × runLoop(loopId)         pickJobWithClaimableWork → claimAndApplyChunk → touchLastProgress
  │                               claim = SELECT … FOR UPDATE SKIP LOCKED LIMIT chunkSize
  │                               apply = same transaction; version check → done | skipped_conflict
  │                               failure → isolateChunk: re-claim LIMIT 1, one transaction per item
  └── 1 × runSweepLoop            runFinalizeSweep on its own timer and its own connection
```

---

## 2. Route inventory

| Method | Path | Current handler | Validation | Service | Statuses |
|---|---|---|---|---|---|
| GET | `/health` | `server.ts` inline | none | none | 200 |
| POST | `/jobs/bulk-move` | `routes/jobs.ts` | `Idempotency-Key` header (present, ≤255), `bulkMoveBodySchema` | `submitBulkMoveJob` | 202, 200 (replay), 400, 409, 413 |
| GET | `/jobs/:id` | `routes/jobs.ts` | `jobIdParamSchema` | `getJobProgress` | 200, 400, 404 |
| POST | `/jobs/:id/retry-failed` | `routes/jobs.ts` | `jobIdParamSchema` | `retryFailedItems` | 200, 400, 404 |
| POST | `/opportunities` | `routes/opportunities.ts` | `createOpportunityBodySchema` | `createOpportunity` | 201, 400, 404 |
| POST | `/opportunities/:id/move` | `routes/opportunities.ts` | `opportunityIdParamSchema`, `moveOpportunityBodySchema` | `moveOpportunity` | 200, 400, 404, 409 |
| GET | `/stages/:stageId/opportunities` | `routes/opportunities.ts` | `stageIdParamSchema`, `stageListQuerySchema` | `listStageOpportunities` | 200, 400, 404 |
| ALL | unmatched | `server.ts` | — | — | 404 `not_found` |

Every route except `/health` sits behind `workspaceScope()`.

## 3. Worker / job inventory

| Unit | Trigger | Concurrency | Entry |
|---|---|---|---|
| claim loop | continuous polling; `IDLE_BACKOFF_MS` when nothing claimable | `WORKER_POOL_SIZE` (3) | `runLoop` |
| chunk apply | inside the claim loop, one transaction per chunk of `CHUNK_SIZE` | per loop | `claimAndApplyChunk` |
| isolation pass | a chunk apply threw and `claimedCount > 1` | serial, bounded (a 1-item chunk cannot recurse) | `isolateChunk` |
| finalize sweep | own timer, `SWEEP_INTERVAL_MS` | 1 per process, own `connection_limit=1` client | `runSweepLoop` |

No cron, no external scheduler, no queue broker. A "job name" in this codebase is a `jobs` row, not
a queue message; the registry in the target layout therefore maps **job kinds** to processors, with
exactly one kind today (`bulk-stage-move`).

---

## 4. Findings

### 4.1 Business decisions live in route handlers (fat controllers)
`routes/jobs.ts` owns the `Idempotency-Key` policy: required, ≤255 characters, with the btree
2704-byte rationale. That is a rule about the request, not HTTP plumbing. The same file decides
202-vs-200 from `result.created`.

### 4.2 Validation boilerplate duplicated 8 times
Every handler repeats `const parsed = schema.safeParse(x); if (!parsed.success) { next(ApiError
.badRequest(code, message, issues)); return; }` — 3 sites in `jobs.ts`, 5 in `opportunities.ts`,
with five different error codes (`invalid_body`, `invalid_job_id`, `invalid_opportunity_id`,
`invalid_stage_id`, `invalid_query`). Well past three occurrences: extract a `validate(schema,
{ source, code, message })` middleware that emits the *same* code per site.

### 4.3 No repository layer — 21 raw SQL / Prisma call sites inside services
`queryRaw`/`executeRaw` counts: `jobService` 3, `opportunityService` 2, `progressService` 1,
`retryService` 3, `stageListService` 1, `claimAndApplyChunk` 7, `worker/queries` 4. Business rules
and SQL share a function body, so no service can be unit-tested without Postgres.

### 4.4 No dependency injection on the API side
Services `import { interactivePrisma }` at module level. The worker already does better —
`runLoop(loopId, signal, prisma = jobPrisma)` and every `worker/queries` function takes a client —
which is exactly why worker tests can drive real loops. The API side gets the same treatment.

### 4.5 God file
`src/api/services/jobService.ts` is 290 lines and holds: input/result types, request
fingerprinting, the snapshot CTE, the truncation detector, idempotency replay, the 23505 loser
path, and cross-pipeline validation. Over the 250-line bar and well over one responsibility.

### 4.6 Magic values
Item/job status literals (`'pending'`, `'done'`, `'skipped_conflict'`, `'failed'`, `'running'`,
`'completed'`) appear inline ~20 times across `worker/queries.ts`, `claimAndApplyChunk.ts`,
`progressService.ts`, `retryService.ts`. Error codes (`invalid_body`, `workspace_required`, …) are
inline literals at each throw site. `255` lives in `routes/jobs.ts`; `'1mb'` in `server.ts`.

### 4.7 Inconsistent async style and error translation
Handlers use `.then().catch(next)` promise chains rather than `async/await` behind an
`asyncHandler` wrapper. Prisma/Postgres error translation (23505 → replay, 54000 → 400) happens
inside services and routes rather than at a repository boundary.

### 4.8 Configuration read outside `config/`
`src/db/prismaClients.ts` reads `process.env.PRISMA_LOG`; `src/shared/logger.ts` reads
`process.env.LOG_LEVEL`. Neither is in the validated schema, so neither crashes fast on a typo.

### 4.9 Tooling gaps
No ESLint, no Prettier, no import-order rule, no layer-boundary enforcement, no path aliases. The
`lint` script deliberately does not exist (an earlier decision: aliasing it to a typecheck would be
dishonest naming). Layer rules that are not machine-checked decay.

### 4.10 Looked for, not found
- **N+1 queries:** none. Snapshot, claim, progress aggregate, and keyset page are one round trip each.
- **Circular imports:** none.
- **Unparameterised SQL:** none — every raw statement binds `$n` placeholders.
- **Unvalidated input reaching a service:** none.

---

## 5. Suspected bugs (logged, NOT fixed)

Carried forward from the pre-refactor code review plus this audit. The refactor preserves each
behavior exactly as it is today.

1. **`schemas.ts` date range compares raw ISO strings.** `createdFrom`/`createdTo` refine with `<=`
   on strings, so a valid range expressed with a non-`Z` offset is rejected 400 and an inverted one
   is accepted (silently empty result set). Fix would be `Date.parse` inside the refine.
2. **`schemas.ts` `value` has no scale constraint.** The column is `numeric(14,2)`; `10.555` is
   accepted, then stored and echoed as `10.56`. Money that quietly changes.
3. **`config.ts` comment overstates the worst backoff.** Says `2^5s at MAX_ATTEMPTS=5`; a row at
   `attempts = 5` is terminal, so the worst *served* backoff is `2^3 = 8s`. The conclusion holds;
   the reasoning misleads whoever next tunes `MAX_ATTEMPTS`.
4. **`WORKER_POOL_SIZE == connection_limit` is permitted.** Zero headroom in the loops' pool;
   currently harmless because the sweeper holds its own pool.
5. **SIGTERM drain can exceed a container grace period.** A loop inside a chunk finishes it before
   noticing the abort; past a 10s `stop_grace_period` that ends in SIGKILL. Safe (items roll back
   to `pending`), noisy.
6. **API shutdown has no forced-exit timer.** `server.close()` waits for idle sockets; a keep-alive
   client can hold the process past the grace period. `closeAllConnections()` is never called.
7. **No `unhandledRejection` / `uncaughtException` handlers** in either entrypoint.
8. **No error-code table in the README** — clients discover codes by triggering them.

## 6. Job idempotency review

| Unit | Idempotent? | Mechanism |
|---|---|---|
| bulk-move submission | yes | `(workspace_id, idempotency_key)` unique + `request_fingerprint` 409 |
| chunk apply | yes | partial unique index on `transitions (job_id, opportunity_id)` makes double-apply structurally impossible; `expected_version` decides `done` vs `skipped_conflict` |
| isolation pass | yes | same transaction shape, one item at a time |
| finalize sweep | yes | folded UPDATE guarded by `NOT EXISTS (pending)` plus a `FOR UPDATE SKIP LOCKED` candidate CTE |
| retry-failed | yes | no failed items ⇒ no `jobs` UPDATE at all |

**Not idempotent, by design:** `job_items.attempts` and `next_attempt_at` advance on every failed
apply. That is the backoff mechanism, not a defect — named here because a reader auditing "is this
job idempotent?" deserves the exception stated.

## 7. Security concerns (existing, unchanged by this refactor)

- **No authentication or authorization.** `X-Workspace-Id` is trusted as sent; validating that it
  exists stops forgery of *nonexistent* tenants, not impersonation of real ones. Every
  tenant-isolation guarantee is conditional on something in front terminating auth.
- **No rate limiting.** One caller can submit unlimited 50 000-item jobs.
- **No `helmet`, no CORS policy.** Adding either changes response headers, i.e. behavior.
- **Validation errors echo zod `issues`**, exposing internal field names and schema structure.
  Existing response shape; preserved.
- Logs carry workspace/job/opportunity ids only — no PII, no request bodies.

---

## 8. Target structure

Adapted to this stack: TypeScript stays TypeScript; there is no queue library, so `shared/queue`
becomes `shared/worker-runtime` (loop, abortable sleep, backoff policy) and `jobs/registry.ts` maps
job kind → processor.

```
src/
├── app/
│   ├── createApp.ts          Express factory: middleware order + route wiring, no logic
│   ├── server.ts             HTTP entrypoint: listen, graceful shutdown
│   ├── worker.ts             worker entrypoint: loops + sweeper, graceful shutdown
│   └── container.ts          manual DI: repositories → services → controllers
├── config/
│   ├── env.ts                the ONLY reader of process.env (absorbs PRISMA_LOG, LOG_LEVEL)
│   └── index.ts              typed config object
├── modules/
│   ├── bulk-move/            routes/controller/service/repository/schemas/dto/types/errors/constants
│   │   ├── jobs/             bulk-stage-move.processor.ts (claim+apply), sweep processor
│   │   └── __tests__/
│   ├── opportunities/        create + single move + keyset listing
│   └── workspaces/           workspace lookup behind the scope middleware
├── shared/
│   ├── errors/               AppError base, HttpError subclasses, ERROR_CODES
│   ├── middleware/           requestId, workspaceScope, validate, notFound, errorHandler
│   ├── http/                 asyncHandler, response helpers, pagination
│   ├── database/             prisma clients (interactive/job/sweep), withTransaction, PG error codes
│   ├── worker-runtime/       abortable sleep, loop runner, backoff policy
│   ├── logger/               existing JSON-lines logger + request/job-scoped context
│   ├── utils/                pure helpers (canonical JSON, fingerprint)
│   └── types/                Express augmentation, shared types
├── jobs/registry.ts          JOB_KIND → processor
└── index.ts                  thin re-export
```

### Old → new mapping (parity anchor)

| Current | Target |
|---|---|
| `src/api/server.ts` | `src/app/createApp.ts` + `shared/middleware/errorHandler.ts` + `shared/middleware/notFound.ts` |
| `src/api/index.ts` | `src/app/server.ts` |
| `src/api/errors.ts` | `shared/errors/` (`AppError`, `BadRequestError`, `NotFoundError`, `ConflictError`) |
| `src/api/schemas.ts` | split into `modules/bulk-move/bulk-move.schemas.ts` and `modules/opportunities/opportunities.schemas.ts` |
| `src/api/middleware/workspaceScope.ts` | `shared/middleware/workspaceScope.ts` + `modules/workspaces/workspaces.repository.ts` |
| `src/api/routes/jobs.ts` | `modules/bulk-move/bulk-move.routes.ts` + `.controller.ts` |
| `src/api/routes/opportunities.ts` | `modules/opportunities/opportunities.routes.ts` + `.controller.ts` |
| `src/api/services/jobService.ts` | `modules/bulk-move/bulk-move.service.ts` + `.repository.ts` + `shared/utils/fingerprint.ts` |
| `src/api/services/progressService.ts` | `modules/bulk-move/bulk-move.service.ts` (progress) + `.repository.ts` |
| `src/api/services/retryService.ts` | `modules/bulk-move/bulk-move.service.ts` (retry) + `.repository.ts` |
| `src/api/services/opportunityService.ts` | `modules/opportunities/opportunities.service.ts` + `.repository.ts` |
| `src/api/services/stageListService.ts` | `modules/opportunities/opportunities.service.ts` (listing) + `.repository.ts` |
| `src/db/prismaClients.ts` | `shared/database/prismaClients.ts` |
| `src/shared/config.ts` | `src/config/env.ts` + `src/config/index.ts` |
| `src/shared/logger.ts` | `shared/logger/` |
| `src/worker/index.ts` | `src/app/worker.ts` + `shared/worker-runtime/` |
| `src/worker/claimAndApplyChunk.ts` | `modules/bulk-move/jobs/bulk-stage-move.processor.ts` (+ repository for its SQL) |
| `src/worker/queries.ts` | `modules/bulk-move/bulk-move.repository.ts` (picker, sweep, failure recording) |

## 9. Migration plan

- **Phase 1 — foundations.** `config/env.ts` (absorbing `PRISMA_LOG`/`LOG_LEVEL` at identical
  defaults), `shared/errors`, `shared/logger`, `shared/database`, `shared/http/asyncHandler`,
  `shared/middleware/{validate,errorHandler,notFound,requestId}`, ESLint/Prettier/import-order,
  path aliases, layer-boundary rule. No route or service touched. Suite stays 103/103.
- **Phase 2 — reference module: `opportunities`.** Smallest surface exercising all four layers.
  `git mv` first, then split controller/service/repository, then wire through `container.ts`.
- **Phase 3 — `bulk-move` (API side) and `workspaces`.** Same pattern, one commit per module.
- **Phase 4 — worker.** `app/worker.ts`, `shared/worker-runtime`, processor + repository split,
  `jobs/registry.ts`; graceful shutdown preserved exactly (abort → drain → disconnect).
- **Phase 5 — tests moved to `modules/*/__tests__`, boundary lint rules, README, dead code.**
- **Phase 6 — verification.** build + typecheck + lint + 103/103 + route-by-route parity table,
  plus a `docker compose up` smoke run.

Each phase ends with `npm run build && npm run typecheck && npm run lint && npm test`, all green,
before the next begins.

## 10. Deliberate deviations (decisions taken without asking)

1. **The refactor lands on a new branch `refactor/modular-architecture`**, cut from
   `feat/bulk-stage-move`. That branch is a finished take-home whose merge decision is still open;
   a structural rewrite must not overwrite the artifact being graded.
2. **No `helmet`, no `cors`, no rate limiter.** All three change response headers or add 429s —
   observable behavior, which the contract forbids. Listed as follow-ups instead.
3. **No `pino`/`winston`.** `shared/logger` is already structured JSON-lines with a level filter
   and zero dependencies; swapping it changes log shape, which is behavior for anyone parsing it.
4. **New dev dependencies, justified:** `eslint`, `@typescript-eslint/*`, `prettier`,
   `eslint-plugin-import`, `eslint-config-prettier`. They are the mechanism the brief asks for to
   enforce layer boundaries and import order; without them the layer rules are prose. Boundary
   enforcement uses `import/no-restricted-paths` rather than adding `dependency-cruiser` as a
   second toolchain.
5. **`npm run lint` now exists** — reversing the earlier "no lint script" decision, which was
   justified only while no linter was configured.
6. **`/ready` will be added; `/health` will not change.** The brief asks for both. A new route is
   additive: no existing request changes shape, and the catch-all 404 for `/ready` was never an
   asserted behavior.
7. **`jobs/registry.ts` ships with a single entry.** Near-over-abstraction today; kept because the
   brief names it and because it is where a second job kind lands.
8. **Prisma clients stay lazy `Proxy` wrappers.** Importing a module must not open a connection —
   the unit tests depend on that.
9. **`docker-compose.yml`, `Dockerfile`, and `package.json` script paths get updated** to the new
   entrypoints. Configuration following a file move, not behavior change; the commands
   (`npm run dev`, `docker compose up`) keep their names and effects.
10. **`DESIGN.md` and `BENCHMARKS.md` keep their measurements**; the file paths named inside them
    are updated in Phase 5 so the documents do not point at moved files.

## 11. Follow-ups (out of scope here)

Authentication and authorization; rate limiting; `helmet`/CORS; job cancellation; retention policy
for `job_items` and `transitions`; per-tenant fairness in the picker; the eight suspected bugs
above; an error-code table in the README.

## 12. Parity checklist

Filled in Phase 6; every row verified against a real request/response, not against the diff.

| Route / job | Original location | New location | Verified |
|---|---|---|---|
| GET `/health` | `api/server.ts` | | ☐ |
| POST `/jobs/bulk-move` | `api/routes/jobs.ts` | | ☐ |
| GET `/jobs/:id` | `api/routes/jobs.ts` | | ☐ |
| POST `/jobs/:id/retry-failed` | `api/routes/jobs.ts` | | ☐ |
| POST `/opportunities` | `api/routes/opportunities.ts` | | ☐ |
| POST `/opportunities/:id/move` | `api/routes/opportunities.ts` | | ☐ |
| GET `/stages/:stageId/opportunities` | `api/routes/opportunities.ts` | | ☐ |
| 404 catch-all | `api/server.ts` | | ☐ |
| error envelope | `api/server.ts` | | ☐ |
| claim loop | `worker/index.ts` | | ☐ |
| chunk apply + isolation | `worker/claimAndApplyChunk.ts` | | ☐ |
| finalize sweep | `worker/index.ts` + `worker/queries.ts` | | ☐ |
