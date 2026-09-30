---
id: module-api-submission
type: module
layer: backend
status: complete
tags: [express, api, idempotency, snapshot, cte, truncation, zod]
files:
  - src/api/server.ts
  - src/api/index.ts
  - src/api/errors.ts
  - src/api/schemas.ts
  - src/api/middleware/workspaceScope.ts
  - src/api/routes/jobs.ts
  - src/api/services/jobService.ts
  - src/api/services/opportunityService.ts
  - tests/part2/submission.test.ts
  - tests/part2/idempotency.test.ts
  - tests/part2/idempotencyKeyRace.test.ts
  - tests/part2/truncation.test.ts
  - tests/part2/collision.test.ts
  - tests/part2/snapshot.test.ts
completed: 2026-09-30
---

## What

`POST /jobs/bulk-move`: validates the target stage, snapshots the match set into `job_items` in
one transaction, reports truncation. 202 on create, 200 on replay of a used key. Response
`{ jobId, totalCount, matchedCount, truncated }`. `createApp()` binds no port so supertest drives
it in-process; `src/api/index.ts` does the `listen` plus SIGTERM drain.

## Key decisions

- The filter is stored but NEVER re-evaluated. The snapshot in `job_items` is the authoritative
  guest list; re-running the filter would pick up rows created after submission and drop rows
  edited out of it, making progress unanswerable.
- One statement for the snapshot, and no opportunity id crosses the wire.
- `picked` takes `limit + 1`. The extra row IS the truncation detector — no second unbounded
  `count(*)`. Truncated ⇒ `matchedCount = null`, deliberately not a number that could be read as
  the real total. Retained rows are the oldest by `(created_at, id)`, so a follow-up submission
  gets the next slice.
- Idempotency: the `(workspace_id, idempotency_key)` pre-check is the cheap path, the unique
  constraint is the guarantee. Loser's `23505` is caught and answered with the winner's job (200);
  Postgres makes the loser block on the winner's uncommitted row, so the winner is always visible
  by then, and the loser's snapshot rolls back with its job row.
- Cross-pipeline: BOTH an explicit 400 when `filter.stageId`'s pipeline ≠ target's, AND
  `pipeline_id` pinned in the snapshot predicate for filters naming no stage.
- `workspaceScope` answers 400 (not 404) for an unknown-but-valid workspace uuid, so a caller
  cannot enumerate existing workspace ids. Handlers read `req.workspaceId`, never the header.
- Filter schema is `.strict()`: a misspelled key is a 400, not a silently much wider bulk move.

## Single move (Task 9) — the other half of the collision policy

`moveOpportunity({ workspaceId, opportunityId, targetStageId, expectedVersion? })`. Locked read
(`FOR UPDATE`) then update, in one transaction — a single predicated UPDATE cannot tell 404 from 400
from 409 in its zero-rows case, and the audit row needs `from_stage_id`. The lock also serialises a
manual move against a chunk apply instead of one side merely losing. Target stage validated against
BOTH workspace and the opportunity's `pipeline_id`. A move to the stage already occupied is a no-op:
bumping there would turn every running job's frozen `expected_version` into a conflict over a change
that never happened. Transition written with `job_id = NULL`, which is how the audit trail tells a
human's move from a job's.

The HTTP route lands in Task 13; the service was pulled forward so Task 9's collision test drives
real production code rather than a raw UPDATE.

## Gotchas — measured, contradicts the design doc

`EXPLAIN ANALYZE`, 500k-row workspace, Postgres 16, default `work_mem`:
- stage-only, LIMIT 50001: `Index Scan using idx_opportunities_stage_list`, NO sort node, 120ms
  (3ms at LIMIT 501). Cost tracks the limit, not the match size.
- status+valueMin, LIMIT 50001: `Parallel Seq Scan` → `Sort` (external merge, **spills 3016kB to
  disk**) → `Gather Merge`, 81ms, 130 659 rows removed by filter. Only becomes `top-N heapsort`
  (85kB) at small limits. `idx_opportunities_filter` was NOT chosen at all — status/value are
  ~25% selective here.
- So "memory stays bounded" is false at the real cap, and the O(matches) cost of a broad filter is
  real and paid on the request thread. DESIGN.md (Task 18) must say so.

## Snapshot, not live set — proven both ways (Task 12)

`tests/part2/snapshot.test.ts`. A row that only starts matching after submission — edited into the
filter, or created outright — is never picked up. A row edited OUT of the filter is still moved:
selection is final. A row whose edit also bumped `version` is `skipped_conflict`, so "selection is
final" never means the job overwrites a human.

Teeth verified by removal, twice: making the worker re-evaluate the filter at claim time fails the
"selection is final" case; dropping the status clause from the submission snapshot fails the "only
starts matching afterwards" case.

## Links

- depends-on: module-db-schema, module-db-isolation, module-shared-config
- related-to: module-seed (the 500k dataset the plans were measured against)

## Review fix pass (commit 4246c1d)

Three client-facing defects, all covered by `tests/part2/requestHardening.test.ts`.

- `express.json`'s rejections (unparseable body, body past the 1mb cap) reached the caller as 500s.
  Classified in `server.ts`'s error handler as 400 `invalid_json` and 413 `payload_too_large`.
- An `Idempotency-Key` past the btree 2704-byte index-entry limit surfaced SQLSTATE 54000 as a 500.
  Bounded at 255 characters, 400 `idempotency_key_invalid`.
- A key reused with a *different* filter or target stage was answered with the first job's id and a
  200 — the caller believed a second bulk move was accepted that nothing would ever perform. Jobs
  store `request_fingerprint`, a SHA-256 of the canonicalised `(filter, targetStageId)` (keys sorted,
  `undefined` dropped, so serialisation order is not part of the identity); a mismatch is 409
  `idempotency_key_conflict`. Nullable, and a null skips the comparison, so pre-column jobs still
  replay.

## Phase 1 refactor (commit 05a8167)

`src/api/errors.ts` is now a three-function shim returning `@shared/errors` classes
(`BadRequestError`, `NotFoundError`, `ConflictError`), so every existing throw site keeps its
exact status, code, message and details until its module moves. It is deleted in Phase 3.

`createApp()` lost its inline handlers: `requestId()`, `notFound()` and `errorHandler()` come from
`@shared/middleware` now, and the error handler matches on `AppError` rather than `ApiError`.
Response bytes are unchanged — including that `details` is still omitted when undefined — which
the untouched supertest suites prove.

Gotcha: `AppError` exposes `statusCode`, not the old `status`. Two service-level assertions in
`tests/part2/collision.test.ts` were updated; no HTTP response changed.

## Restructured into src/modules/bulk-move (Phase 3 refactor, commit 63d221a)

`src/api/` is gone. The 290-line `jobService.ts` split along its seams:

- `bulk-move.repository.ts` — the snapshot CTE, the filter predicates, the progress aggregate, the
  retry transaction. The measured EXPLAIN plans stayed with the statement they describe.
- `bulk-move.service.ts` — the decisions: stage-check order, replay 200 vs 409, and the
  progress classification (`classify()` moved here from progressService).
- `bulk-move.middleware.ts` — the `Idempotency-Key` policy (required, ≤255). Validation, so it
  runs before the route and therefore before the snapshot query.
- `bulk-move.controller.ts` / `.routes.ts` / `.schemas.ts` / `.types.ts` / `.errors.ts` /
  `.constants.ts`.

Seven domain errors replace inline pairs: `IdempotencyKeyRequired/Invalid/Conflict`,
`TargetStageInvalid`, `FilterStageInvalid`, `CrossPipelineMove`, `JobNotFound`.

`fingerprintRequest(filter, targetStageId)` is now `fingerprint(value)` in `@shared/utils` — the
same canonical-JSON SHA-256 over the same `{ filter, targetStageId }` object, so **stored
fingerprints still match**; the helper just no longer knows what a filter is.

15 service unit tests in `__tests__/` cover the replay/409 rules, the key race (loser gets the
winner's job), the pre-fingerprint null case, and all five classifications — no database.
