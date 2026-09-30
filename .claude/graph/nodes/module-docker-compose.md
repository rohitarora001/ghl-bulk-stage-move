---
id: module-docker-compose
type: module
layer: devops
status: complete
tags: [docker, compose, podman, topology, healthcheck]
files:
  - Dockerfile
  - docker-compose.yml
completed: 2026-09-30
---

## What it does
`docker compose up --build` brings up `postgres` + `postgres-test`, runs migrations, seeds the
small demo dataset, starts `api` (port 3000) and `worker` (pool 3), and runs the Jest suite in a
`test` service whose logs stream inline.

## Key decisions
- **One image for all five services.** `api`, `worker`, `migrate`, `seed` and `test` differ only
  in the command compose gives them; five images would mean five copies of node_modules and five
  chances for them to drift apart. Shared via the `x-app: &app` / `&app-env` YAML anchors.
- **Not compiled.** The same image runs Jest, which needs the TypeScript sources, so everything
  goes through `ts-node`. A compiled image would force a second image to exist.
- **Ordering by health check, never by sleep.** `depends_on` alone only waits for a container to
  start, and Postgres accepts TCP several seconds before it answers queries — that wiring fails on
  a cold machine and passes on a warm one. `migrate` waits `service_healthy`; `seed`, `api` and
  `worker` wait `service_completed_successfully`.
- **`pg_isready -U postgres -d ghl`, not bare `pg_isready`:** the bare form checks the default
  database and reports ready while `ghl` is still being created by the entrypoint.
- **A second database for the suite.** The tests TRUNCATE every table between cases, so pointing
  them at `postgres` would destroy the demo dataset while `api` and `worker` serve from it.
  `postgres-test` has no volume — a test database that survives a restart has state in it.
- **No `--abort-on-container-exit`.** `test` finishing must not tear down `api` and `worker`.
- `seed` runs with `--reset`, so `compose up` twice does not stack two demo datasets. Small
  dataset only; the 500k benchmark set is `npm run seed -- --large`, run deliberately.
- The `test` service declares no dependency on `migrate`: jest's `globalSetup` runs
  `prisma migrate deploy` against whatever `DATABASE_URL_ADMIN` names.

## Gotchas
- Host ports 55432/55433 are published. The local dev container `ghl-pgtest` also binds 55433, so
  it must be stopped for the duration of a compose run and restarted afterwards.
- Prisma's engines need OpenSSL and `node:22-bookworm-slim` does not ship it — the Dockerfile
  installs `openssl ca-certificates` explicitly.
- `prisma` is copied alongside the manifests before `npm ci`, because `npm ci` runs prisma's
  postinstall `generate`.

## Measured (Task 15, podman compose)
`podman compose -f docker-compose.yml config` → exit 0. Full `podman compose up --build`:
`migrate` Exited (0); `seed` Exited (0) — "reset: 7 tables truncated", 5000 + 2000 + 2000
opportunities, "seed complete in 1.0s"; `test` Exited (0) — **25 suites, 93 tests passing in
45.1s**; `api` (0.0.0.0:3000->3000) and `worker` still Up afterwards. No podman-specific issues.

## Links
- depends-on: [[module-db-isolation]] (scripts/migrate.ts is the migrate service's command)
- depends-on: [[module-seed]] (the seed service's command and its `--reset` flag)
- related-to: [[module-shared-config]] (`WORKER_POOL_SIZE: '3'` against `connection_limit=3`)

## Phase 1 refactor (commit 05a8167)

All four `ts-node` service commands gained `-r tsconfig-paths/register`. The app now imports
through path aliases (`@config`, `@shared/*`), which ts-node does not resolve on its own — without
the loader the `api` and `worker` services die on their first import. The compiled path is
unaffected: `npm run build` runs `tsc-alias`, which rewrites the aliases in `dist/`.

## Phase 4 refactor (commit 4dce5c2)

The `worker` service command now names `src/app/worker.ts`; the `api` service named
`src/app/server.ts` in Phase 3. `package.json` (`main`, `dev:api`, `dev:worker`, `start`,
`start:api`, `start:worker`) follows the same two paths. `src/api/` and `src/worker/` no longer
exist.

## End-to-end run after the refactor (commit ee5ee91, podman compose)

Full `podman compose up --build` from a clean `down -v`: `postgres`/`postgres-test` healthy,
`migrate` and `seed` exit 0, `api` listening, worker logging 3 `loop_started` + `sweeper_started`,
`test` **32 suites / 129 tests in 55s**, `api` and `worker` still up afterwards. A live bulk move
of 289 opportunities completed with 289 transitions and correct 202/200/409 idempotency responses.

**Gotcha that cost a container start:** `ts-node` compiles only what the entrypoint imports, so
`src/shared/types/express.d.ts` was invisible and `req.id` failed to compile — the API exited 1
while every local gate was green (`tsc` and ts-jest both read `include`). Fixed with
`"ts-node": { "files": true }` in tsconfig. **A tsconfig change needs `compose up --build`, not
`--force-recreate`: the image has its own copy.**

**Measured defect, left unfixed (behavior change):** the compose worker never runs its graceful
shutdown. `podman stop --time 15` produced zero `worker_shutdown`/`loop_stopped` lines and exit
code 1, because the command is `['npx', 'ts-node', …]` and npx is PID 1, so SIGTERM kills the Node
child before the handler runs. Data is unaffected. This settles the long-open question in
[[module-worker]]: the drain is not slow, it never starts.
