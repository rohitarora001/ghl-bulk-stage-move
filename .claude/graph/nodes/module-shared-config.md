---
id: module-shared-config
type: module
layer: backend
status: complete
tags: [config, zod, logger, toolchain]
files:
  - src/shared/config.ts
  - src/shared/logger.ts
  - tests/unit/config.test.ts
  - tsconfig.json
  - jest.config.js
  - package.json
completed: 2026-09-30
---

## What it does
Parses and validates every tunable from the environment in one zod schema, and provides a
dependency-free JSON-lines logger. `loadConfig(env)` is pure; `getConfig()` memoizes it against
`process.env`.

## Key decisions
- `getConfig()` is lazy rather than an eagerly-evaluated `export const config`: an eager parse
  throws at import time in unit tests that never touch a database.
- `WORKER_POOL_SIZE` is validated against the `connection_limit` in `DATABASE_URL_WORKER`, and a
  worker URL with no `connection_limit` is rejected outright. Each worker loop holds one pooled
  connection for its entire claim+apply transaction, so surplus loops do not degrade — they block
  forever. Better to fail at boot than to hang.
- `npm run lint` intentionally does not exist; `npm run typecheck` (`tsc --noEmit`) is the check.

## Gotchas
- TypeScript must stay on 5.x. TypeScript 7 (npm `latest`) is the Go-native port and does not
  expose the JS compiler API ts-jest 29 needs — the suite fails to run at all, with a message
  about `@typescript/native`.
- `jest.config.js` sets `maxWorkers: 1` deliberately: the suite drives one real Postgres and
  parallel workers would race on `TRUNCATE`.
- Blank-but-exported shell variables are stripped before parsing, so `FOO=` reads as absent
  rather than as `""`.

## Acceptance criteria
- [x] Defaults match the design doc (chunk 500, cap 50000, pool 3, attempts 5, sweep 2000 ms)
- [x] Missing variables throw naming the variable
- [x] Numeric vars coerce to `number`
- [x] Pool/connection_limit invariant enforced, 5/5 tests green, typecheck clean

## STUCK_AFTER_MS (Task 11)

Staleness window for the progress endpoint's *stuck* classification. Default 60000ms, chosen to
exceed the worst backoff a healthy job serves (2^5s at MAX_ATTEMPTS=5), so a job merely waiting
out its own retries is never reported as needing a human. See [[module-api-observability]].

## Moved to src/config (Phase 1 refactor, commit 05a8167)

`src/shared/config.ts` → `src/config/env.ts`, re-exported by `src/config/index.ts` under the
`@config` alias. Same schema, same lazy `getConfig()`, same `resetConfigCache()` test seam.

`LOG_LEVEL` and `PRISMA_LOG` were absorbed from the logger and the Prisma clients as
`readLogLevel()` / `readPrismaLogMode()`, but deliberately **outside** the strict schema: they
change how the process talks, not what it does, so a typo must not stop a worker from draining a
job. They are also uncached, because the suite flips `LOG_LEVEL` between cases.

`npm run lint` now exists (ESLint 9 flat config), reversing this node's earlier decision — that
decision held only while no linter was configured. See [[decision-modular-refactor]].

## tsconfig modernised (commit 6adf707)

Two options TypeScript 5.9 still accepts but 7.0 will drop were removed rather than silenced with
`ignoreDeprecations`:

- **`baseUrl` deleted.** `paths` has not needed it since TS 4.4; entries are now written relative
  to the tsconfig (`"@shared/*": ["./src/shared/*"]`).
- **`module` and `moduleResolution` are `node16`.** The current setting for a CommonJS Node
  service; emit stays CommonJS.

Gotcha worth keeping: the editor's bundled compiler is ahead of the installed one, so these showed
as errors in the Problems panel while `npm run typecheck` was green. A clean typecheck is not
evidence that the config is future-proof.

Resolution mode affects runtime, so this was verified past the type checker: `dist` loads under
plain `require`, and the suite's spawned-worker integration test drives ts-node with this config —
the same mechanism the compose services use.

Also: `dist/` is never cleaned by `tsc`, and was still carrying `dist/src/api/` and
`dist/src/worker/` from before the refactor. `rm -rf dist` before a release build, or the shipped
output contains modules that no longer exist in source.

## isolatedModules (commit 6140b43)

`module: node16` made ts-jest emit **TS151002 on every suite** — 84 warnings in one container run —
because a hybrid module kind is only supported with `isolatedModules: true`. Tests passed
throughout, so it was noise, but a green run has to look green (same reason the suite sets
`PRISMA_LOG=silent`).

`isolatedModules: true` also describes what was already true: ts-jest compiles each file on its
own. Nothing had to change to satisfy it — type-only re-exports already use `export type`, which
the `consistent-type-imports` lint rule enforces.

Gotcha: this warning only appears where ts-jest runs, so it is invisible to `npm run typecheck`
and `npm run build`. It surfaced in a compose test run.

