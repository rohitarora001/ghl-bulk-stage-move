---
layer: backend
stack: Node 22, TypeScript 5.9, Express 5, Prisma 6, PostgreSQL 16, Jest, zod
triggers-on: [express, route, controller, service, repository, module, prisma, sql, migration, postgres, worker, job, queue, tenant, workspace, idempotency, transaction, index, test, jest]
created: 2026-09-30
lastReviewed: 2026-09-30
reviewIntervalDays: 30
projectStage: active-development
---

These are the rules this codebase already follows, derived from its own decisions rather than from
a template. Where a rule is enforced mechanically, the enforcer is named — prose that nothing
checks decays. The long-form versions live in `README.md` (layers, conventions, adding a module)
and `DESIGN.md` (why the concurrency model is what it is); this file is the short form for deciding
day to day.

## Architecture

- **Feature modules, four layers, dependencies inward only.** `routes → controller → service →
  repository`. A module owns its schemas, types, errors and constants. `src/app/` is the only
  composition root; `src/shared/` and `src/config/` never import a module.
- **One door to the database per module.** The repository is the only file allowed to import
  `@prisma/client`. Services take repositories as factory parameters and are therefore testable
  without Postgres. If a service needs a row type, the module re-exports it (`OpportunityRecord`) —
  a hand-written parallel interface would drift and silently change a response body.
- **Enforced, not requested.** `eslint.config.mjs` fails the build on: `shared/`/`config/`
  importing a module, a module importing the composition root, `*.service.ts` importing
  `@prisma/client` or `express`, `*.controller.ts` importing a repository, and any import cycle.
  Add a layer rule there in the same commit you start relying on it.
- **`src/config/` is the only reader of `process.env`.** App tunables are strict — a bad value
  crashes at boot with the variable named. Observability switches (`LOG_LEVEL`, `PRISMA_LOG`) are
  lenient and uncached: they change how the process talks, not what it does, and a typo must never
  stop a worker from draining a job.
- **Services throw; only `errorHandler` writes a status code.** Every error is an `AppError`
  subclass carrying a code from `ERROR_CODE`. A new error code is a new named class in the module's
  `*.errors.ts`, never an inline string at the throw site.
- **The queue is a table.** `job_items.status` is the cursor; there is no broker and no persisted
  offset. A job kind is a processor that finds its own work, registered in `src/jobs/registry.ts`.
  Processors stay thin — they own the retry cadence, the service owns what happens to the rows.
- **No module-level singletons in business logic.** The only ones are the Prisma clients in
  `shared/database`, and they are lazy `Proxy` wrappers so importing a module opens no connection.

## TDD

- **Write the test, watch it fail, then implement.** A test that never failed proves nothing about
  the code — only that it compiles.
- **When a natural RED is unreachable, prove teeth by removal.** Several behaviours here are
  properties of the schema or of an existing statement, so a new test passes on first run. The
  substitute this project uses, repeatedly and on purpose: delete the mechanism, watch the test
  fail for the stated reason, restore it. Dropping the claim index made the plan test name
  `job_items_pkey`; dropping `AND status = 'pending'` made the resume test time out; dropping the
  workspace predicate failed the isolation test. Record what you removed and what broke.
- **Two test homes, one rule each.** Service unit tests sit in `src/modules/*/__tests__/` and run
  against fake repositories with no database — fast enough to run on every save. Anything needing
  real Postgres lives under `tests/` and truncates between cases.
- **Assert on committed state.** Progress, conflicts and idempotency are claims about what is in
  the database, so read it back. Asserting on a mock's call count proves the mock works.
- **`maxWorkers: 1` is deliberate** — the suite drives one real Postgres and parallel workers race
  on `TRUNCATE`.
- **A green suite is not a green system.** The API once passed every local gate and still died at
  container start, because `ts-node` and `tsc` disagree about which files exist. Run the stack
  before believing the work is done.

## SOLID

Applied to factory functions, not classes — this codebase has almost no inheritance and does not
need any.

- **Single responsibility:** files stay under ~250 lines and change for one reason. The 290-line
  `jobService` held fingerprinting, the snapshot CTE, idempotency replay and validation; splitting
  it along those seams is what made each piece testable.
- **Open/closed:** a new job kind is a processor plus one line in the registry. A new endpoint is a
  new module plus one line in `createApp`. Neither edits existing behaviour.
- **Interface segregation:** repository interfaces name intent (`findStageInPipeline`,
  `claimPendingItems`), not Prisma shapes. A caller should not have to know whether the answer came
  from a model call or raw SQL.
- **Dependency inversion:** services depend on a repository interface, middleware depends on a
  function (`workspaceScope({ workspaceExists })`). That is what keeps a cross-cutting concern from
  importing a feature module.

## Security

- **`X-Workspace-Id` is scope, not authentication.** There is no auth in this system. The header is
  validated against the `workspaces` table and every query still filters on the workspace — the
  scope is a convenience, never the guard.
- **Never let a response confirm what exists.** An unknown workspace is `400`, not `404`, so ids
  cannot be enumerated. Another tenant's row answers exactly as a row that does not exist: `404`.
- **Unplanned errors say nothing.** `500` carries a fixed message; the detail goes to the log. An
  error string is as likely to leak a table name as to help the caller.
- **Parameterised SQL only.** Raw statements bind `$n` through tagged templates or
  `Prisma.sql`/`queryRawUnsafe` with parameters. Never interpolate a caller's value into SQL text.
- **Bound anything caller-supplied that reaches an index.** An `Idempotency-Key` past the btree
  2704-byte limit surfaced as a `500`; it is capped at 255 characters at the edge.
- **Least privilege at the database.** Two login roles, neither holding `DELETE`, `TRUNCATE` or
  DDL, each with its own `statement_timeout` set via `ALTER ROLE` so it applies however the
  connection is opened.
- **Logs carry ids, never payloads.** Workspace, job and opportunity ids are enough to correlate;
  request bodies are not ours to persist.

## Performance

- **The connection cap is the isolation mechanism.** `DATABASE_URL_WORKER`'s `connection_limit` is
  what stops a bulk job starving interactive traffic — not the process split, which would give
  separate pools anyway. `WORKER_POOL_SIZE` is validated against it at boot, because surplus loops
  do not degrade gracefully, they block forever.
- **One statement beats a read then a write.** Anything that reads and then writes the same rows is
  a race whenever another loop, the sweeper or an operator can touch them. Fold the decision into
  the UPDATE; use `FOR UPDATE SKIP LOCKED` for claims and a deterministic `ORDER BY id` for locks.
- **Set-based, always.** Seeding, snapshotting and applying a chunk are single statements over
  arrays. No row loops, and no shipping 50 000 ids to Node only to send them straight back.
- **`limit + 1` instead of a second `count(*)`.** The extra row is the has-more detector and the
  truncation detector; a separate count would be stale before it returned.
- **Measure, then claim.** `EXPLAIN (ANALYZE, BUFFERS)` before asserting a plan, and when a plan is
  load-bearing, pin it in a test — `claimPlan.test.ts` fails if the claim query stops using its
  index. `BENCHMARKS.md` is generated from real runs; numbers are never written by hand.
- **State the shape of a cost, not a reassurance.** A measured plan here spills to disk at the real
  50 000 cap while looking memory-bounded at small limits. Write down the size at which the claim
  stops holding.

## DRY

- **Three occurrences before abstracting; never two.** `validate()` exists because eight route
  handlers repeated the same `safeParse` block with five different error codes. A helper used once
  stays in the module that uses it.
- **Names, not strings.** Statuses, error codes, headers, limits and job kinds are constants or
  named error classes. A magic string is a decision nobody can grep for.
- **`shared/` is for what two or more modules need.** A cursor codec is shared; the rule for what
  makes a valid cursor belongs to the module that issues it.
- **Comments explain why.** The what is the code's job. Where a decision was measured, the comment
  carries the measurement, and it lives on the statement it describes — not in a doc that will drift
  away from it.
