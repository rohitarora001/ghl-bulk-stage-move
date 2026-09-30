---
id: decision-modular-refactor
type: decision
layer: backend
status: complete
tags: [refactor, architecture, layering, di, eslint, phases]
files:
  - REFACTOR_NOTES.md
completed:
---

## What it is

The architectural refactor of the shipped take-home into feature-based modules with strict
layering (routes → controller → service → repository), manual DI, shared middleware, and
machine-enforced layer boundaries. `REFACTOR_NOTES.md` is the living record: audit, findings,
suspected bugs, deviations, migration plan, parity checklist.

**The binding contract is zero behavior change.** Same routes, response shapes, status codes,
error envelope, DB schema, env vars, and worker semantics. Anything that looks like a bug is
logged under "Suspected Bugs", never fixed silently.

## Key decisions

- Lands on branch `refactor/modular-architecture`, cut from `feat/bulk-stage-move`. That branch is
  a finished deliverable whose merge decision is still open; the rewrite must not overwrite it.
- No `helmet`, `cors`, or rate limiter: each changes response headers or adds 429s, which is
  observable behavior. Follow-ups, not refactor work.
- No `pino`/`winston` — [[module-shared-config]]'s logger is already structured JSON-lines with
  zero dependencies, and swapping it changes log shape.
- New dev dependencies limited to the lint toolchain (eslint, @typescript-eslint, prettier,
  eslint-plugin-import). Layer boundaries are enforced with `import/no-restricted-paths` rather
  than adding dependency-cruiser as a second toolchain.
- `npm run lint` now exists, reversing [[module-shared-config]]'s "no lint script" decision, which
  held only while no linter was configured.
- There is no queue library: the queue is `job_items` and `status` is the cursor. The target's
  `shared/queue` becomes `shared/worker-runtime`, and `jobs/registry.ts` maps job *kind* →
  processor with one entry today.
- Prisma clients stay lazy `Proxy` wrappers — importing a module must not open a connection.

## Audit findings (Phase 0)

Fat route handlers (the `Idempotency-Key` policy lives in `routes/jobs.ts`); validation
boilerplate repeated 8 times; 21 raw SQL sites inside services with no repository layer; API
services importing the client singleton at module level while the worker already injects it;
`jobService.ts` at 290 lines; ~20 inline status literals; `.then().catch(next)` instead of an
async handler; `PRISMA_LOG`/`LOG_LEVEL` read outside config.

Looked for and absent: N+1 queries, circular imports, unparameterised SQL, unvalidated input
reaching a service.

## Gotchas

- Tests import production modules by path, so every move needs test imports updated in the same
  commit; path aliases (`@modules/*`, `@shared/*`, `@config/*`) exist to stop that recurring.
- `docker-compose.yml`, `Dockerfile` and `package.json` scripts name the old entrypoints
  (`src/api/index.ts`, `src/worker/index.ts`) and must follow the move — see
  [[module-docker-compose]].
- `DESIGN.md` and `README.md` name moved files throughout — see [[docs-design-readme]].

## Acceptance criteria

- [x] Phase 0 audit committed (285529b), no source touched
- [x] Phase 1 foundations (config, errors, logger, database, middleware, tooling) — 05a8167
- [x] Phase 2 reference module (opportunities) — 4f90ede
- [x] Phase 3 remaining modules (bulk-move, workspaces) — 63d221a
- [x] Phase 4 worker (runtime, processor, registry, shutdown) - 4dce5c2
- [x] Phase 5 docs, boundary lint rules, dead code - a8ed182
- [x] Phase 6 build + typecheck + lint + 129/129 + route-by-route parity - a8ed182

## Phase 1 landed (commit 05a8167)

`src/config/` (env.ts + index.ts) is now the only reader of `process.env`; `shared/errors`,
`shared/database`, `shared/http`, `shared/middleware`, `shared/logger`, `shared/types` exist;
ESLint 9 flat config enforces import order, `import/no-cycle`, and the layer boundaries as
`import/no-restricted-paths` plus per-layer `no-restricted-imports`. Suite 103/103, lint, build
and typecheck all clean.

Two runtime loaders were needed for the path aliases and are now load-bearing: `tsconfig-paths`
for anything run through ts-node (dev scripts, compose commands, and the two places that spawn a
real process — `tests/integration/killResume.test.ts` and `scripts/benchmark/common.ts`), and
`tsc-alias` to rewrite aliases in `dist/`. The spawned-worker test is what caught it, by dying on
its first import.

## Phase 2 landed (commit 4f90ede)

`opportunities` is the reference module and the pattern every later module copies:
routes → controller → service → repository, wired in `src/app/container.ts`
(`createContainer()` plus a process-wide `container`). Suite 114/114 (103 + 11 new unit tests),
lint/build/typecheck clean. Details in [[module-api-part1]].

The layer lint earned its place immediately by rejecting this commit's own first draft, where the
service imported a type from `@prisma/client`.

## Phase 3 landed (commit 63d221a) — `src/api/` no longer exists

`bulk-move` and `workspaces` modules added; `app/createApp.ts` and `app/server.ts` are the Express
factory and HTTP entrypoint. Suite 129/129 (103 original + 11 + 15 unit tests), lint/build/
typecheck clean.

- `createApp(dependencies = container)` takes its container as a defaulted parameter, so a test can
  build an app over fakes.
- Express request augmentation is consolidated in `shared/types/express.d.ts` (`id`,
  `workspaceId`, `idempotencyKey`, `validated`), each field naming the middleware that writes it —
  two modules had been declaring their own `declare global` blocks, which also tripped
  `@typescript-eslint/no-namespace`.
- Entrypoint paths moved: `package.json` (`main`, `dev:api`, `start`, `start:api`) and the compose
  `api` service now name `src/app/server.ts` — see [[module-docker-compose]].

Remaining: Phase 4 (worker → `app/worker.ts` + `modules/bulk-move/jobs/` + `jobs/registry.ts`),
Phase 5 (tests relocated, README), Phase 6 (parity check).

## Phase 4 landed (commit 4dce5c2)

Worker split along the same layers as the API; `src/worker/` deleted. Suite 129/129 including the
spawned-process kill-and-resume test, which exercises the new entrypoint for real. Details in
[[module-worker]].

New alias `@jobs/*` for `src/jobs/` (tsconfig + jest moduleNameMapper — the two are kept in sync
by hand).

## Attribution removed from history (user request)

All 25 commits on `main`, `feat/bulk-stage-move` and `refactor/modular-architecture` were rewritten
with `git filter-branch --msg-filter` to drop the `Co-Authored-By: Claude` trailer, verified
tree-identical to the pre-rewrite backups, then force-pushed. Backup branches, `refs/original/` and
the reflog were cleared. The "Generated with Claude Code" footer was removed from both PR bodies.
**Do not add either line to future commits or PRs in this repo.**

## Phases 5 and 6 landed (commit a8ed182) — refactor complete

Docs rewritten ([[docs-design-readme]]), dead code removed, parity checklist filled in.

**Dead code removed:** `logger.withContext` (added Phase 1, never used), `JOB_ITEM_STATUS` (the SQL
names those values inline), `UnauthorizedError` and `ForbiddenError` (nothing can throw them while
there is no auth in scope). `PayloadTooLargeError` was kept and used in `errorHandler` instead of a
bare `res.status(413)`.

**Deviation 14 — the Postgres-backed tests stay under `tests/`.** Service unit tests are colocated
in `modules/*/__tests__/`; the rest need a real database, a migrated schema and a truncate between
cases, which makes them integration tests. Moving thirty passing files would have been churn with a
real chance of breaking the suite that proves a killed worker resumes.

Final gates: `build`, `typecheck`, `lint` clean; **32 suites / 129 tests**. The parity checklist in
`REFACTOR_NOTES.md` traces every route and job from its original file to its new home, naming the
pre-refactor test that exercises it.
