---
id: module-api-observability
type: module
layer: backend
status: complete
tags: [express, api, progress, classification, backoff, retry, replay]
files:
  - src/api/services/progressService.ts
  - src/api/services/retryService.ts
  - src/api/routes/jobs.ts
  - src/api/schemas.ts
  - tests/part2/progress.test.ts
  - tests/part2/retryFailed.test.ts
completed: 2026-09-30
---

## What

`GET /jobs/:id` → `{ id, status, totalCount, matchedCount, truncated, counts: { done, pending,
skippedConflict, failed }, backedOff, lastProgressAt, errorMessage, classification }`.
`POST /jobs/:id/retry-failed` → `{ jobId, retriedCount }`.

## Key decisions

- Every number comes from committed rows, in ONE query — four `count(*) FILTER` aggregates, the
  `backedOff` aggregate, and the `jobs` row from a single snapshot, so counts a caller compares
  against each other cannot be split by a concurrent chunk. No in-memory counter: a restart would
  lose it and a second worker would never see it.
- `backedOff = count(*) FILTER (WHERE status='pending' AND next_attempt_at > now())` is what makes
  *stuck* honest. A stalled `last_progress_at` alone cannot tell a job waiting out its own
  exponential backoff (expected, self-healing) from a dead worker — both stall it identically.
- Classification order: terminal `jobs.status` wins → `pending == 0` ⇒ `running` (sweep pending) →
  `backedOff == pending` ⇒ `backing_off` **regardless of freshness**, because when nothing is
  claimable no worker can be failing to claim it → stale ⇒ `stuck` → else `running`.
- Staleness is `coalesce(last_progress_at, created_at) < now() - STUCK_AFTER_MS`. `created_at` as
  the fallback: a job that never progressed is not automatically fresh, it is as old as its
  submission. Default 60s — longer than the worst backoff a healthy job serves at MAX_ATTEMPTS=5.
- LEFT JOIN so a zero-item job answers with zeroes rather than 404. Workspace is in the same
  predicate that finds the row, so another tenant's job is indistinguishable from a missing one.
- Retry-failed is a **replay, not a force**: `expected_version` is left exactly as the snapshot
  froze it, so an item a human edited while it sat `failed` comes back `skipped_conflict` instead
  of being overwritten. Proven by a test that would pass under a force-apply implementation only
  if the version were refreshed.
- The `jobs` row is locked (`FOR UPDATE`) FIRST and reset to `running` in the SAME transaction
  that makes the items pending. Two reasons: a job left `failed` with pending items is invisible
  to the picker, and `runFinalizeSweep` skips locked candidates — which is the only thing that
  stops the sweep finalizing this job off a snapshot taken before the items came back. This is the
  obligation `module-worker`'s sweep doc comment places on every writer that makes work claimable.
- `retriedCount == 0` deliberately does NOT touch `jobs`: a second call must not un-finish a job
  that finished. No `Idempotency-Key` — a second call is already a 0-row no-op.
- `:id` goes through `jobIdParamSchema` so a malformed id is a 400, not a Postgres cast error.

## Links

- depends-on: module-db-schema, module-db-isolation, module-shared-config
- related-to: module-api-submission, module-worker

## Moved into bulk-move (Phase 3 refactor, commit 63d221a)

`progressService.ts` and `retryService.ts` are gone. The progress query and the retry transaction
live in `modules/bulk-move/bulk-move.repository.ts`; `classify()` and the `JobNotFoundError` throw
live in `bulk-move.service.ts`. Same single-statement aggregate, same LEFT JOIN, same
`STUCK_AFTER_MS` semantics, same response shape.
