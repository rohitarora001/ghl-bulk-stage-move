---
id: module-db-isolation
type: module
layer: backend
status: complete
tags: [postgres, roles, pooling, isolation, migrations]
files:
  - tests/part2/isolation.test.ts
  - prisma/sql/000_roles.sql
  - prisma/sql/999_grants.sql
  - scripts/migrate.ts
  - src/db/prismaClients.ts
  - tests/db/roles.test.ts
completed: 2026-09-30
---

## What it does
Splits database access into two login roles with their own server-side `statement_timeout`s and
their own pooled Prisma clients: `app_interactive` (10s, `connection_limit=15`, API only) and
`app_worker` (30s, `connection_limit=3`, worker only). `scripts/migrate.ts` is the project's
migration runner — roles, then `prisma migrate deploy`, then grants.

## Key decisions
- The isolation mechanism is `app_worker`'s `connection_limit`, not the api/worker process split.
  Separate processes would hold separate pools even with identical config; the hard Postgres-side
  cap is what stops a bulk job from starving interactive traffic.
- `statement_timeout` is set with `ALTER ROLE … SET`, not only in the connection string, so it
  applies however the connection is opened and `pg_stat_activity` grouped by `usename` becomes a
  direct job-vs-interactive isolation proof the benchmarks reuse.
- Both roles share one grant matrix (SELECT/INSERT/UPDATE; no DELETE, TRUNCATE or DDL). Nothing
  in the app ever deletes a row, so a role that can delete is more authority than is needed.
- The two exported clients are lazy `Proxy` wrappers, so importing the module opens no connection.

## Gotchas
- Grants must re-run on *every* `npm run migrate`, not once: `GRANT … ON ALL TABLES` only covers
  tables that exist when it runs, and later migrations add `jobs`/`job_items`.
- `$executeRawUnsafe` refuses multi-statement SQL (42601). `scripts/migrate.ts` exports a
  `splitStatements` that tracks `$$` dollar-quoting, because the roles file's `DO $$…$$` block is
  full of semicolons.
- Tests set `PRISMA_LOG=silent`; several deliberately provoke 42501 / 57014, which Prisma would
  otherwise print and make a green run look broken.
- The `statement_timeout` enforcement test costs ~10s of wall clock. It is asserted once, on the
  interactive role, because the mechanism is identical for both.

## Acceptance criteria
- [x] `pg_roles.rolconfig` carries 10s / 30s; live connections report the same via `current_setting`
- [x] A query past the bound is cancelled with SQLSTATE 57014
- [x] DELETE and CREATE TABLE both denied (42501) for the application roles
- [x] 6/6 green, full suite 18/18, typecheck clean

## End-to-end isolation proof (Task 12)

`tests/part2/isolation.test.ts` runs a real bulk job in workspace A and compares the whole of
workspace B before and after, column by column including `version` and `updated_at`, plus zero
`job_items` and zero `transitions`. B's rows are deliberately given the same source stage position,
status and value as A's, so nothing but the workspace id distinguishes them — the submitted filter
names no workspace and cannot, so the scope predicate is the only thing standing.

**Measured, worth knowing:** removing `o.workspace_id` from the snapshot predicate does NOT fail
this test. `o.pipeline_id` pins the set independently, and pipelines are workspace-scoped, so the
two predicates are redundant for the cross-tenant case. Removing both fails it. Defense in depth,
not a redundant clause to clean up — a future filter that made `pipeline_id` optional would leave
`workspace_id` as the only guard.

Also covered: a target stage in another workspace is a 400 with no job row written, and
`GET /jobs/:id` / `POST /jobs/:id/retry-failed` answer 404 across tenants — see
[[module-api-observability]].

## Review fix pass (commit 4246c1d)

A third client: `sweepPrisma`, the worker URL with `connection_limit` forced to 1. The worker
process therefore holds `connection_limit` backends for its claim loops plus one for the finalize
sweeper. The sweeper is given a connection nothing else can hold because it must not queue behind
three chunk transactions, each allowed to run for 60s — the delay it exists to prevent. See
[[module-worker]].

## Moved to shared/database (Phase 1 refactor, commit 05a8167)

`src/db/prismaClients.ts` → `src/shared/database/prismaClients.ts`, behind `@shared/database`.
The three lazy `Proxy` clients are unchanged; only the `PRISMA_LOG` read moved out to
[[module-shared-config]]'s `readPrismaLogMode()`.

Added alongside them: `withTransaction(prisma, work, options)` — services own transaction
boundaries, repositories join them via the `DbClient` type — and `postgresErrors.ts`, which names
the codes this system actually reacts to (23505, 42501, 54000, 57014, P2002, P2025) instead of
leaving them as bare strings in catch blocks.

## workspaceScope inverted (Phase 3 refactor, commit 63d221a)

The tenant-scope middleware now lives at `src/shared/middleware/workspaceScope.ts` and takes
`{ workspaceExists }` from the composition root instead of importing a Prisma client. The lookup
itself is `modules/workspaces/workspaces.repository.ts`.

Why: the ESLint layer rule forbids `shared/` importing a feature module, and middleware is a
cross-cutting concern. Injecting keeps the concern shared and the SQL in the module that owns the
table. Behaviour is unchanged — still 400 (never 404) for an unknown workspace, so a caller cannot
enumerate which workspace ids exist.
