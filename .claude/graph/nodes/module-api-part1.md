---
id: module-api-part1
type: module
layer: backend
status: complete
tags: [express, api, crud, keyset-pagination, cursor, optimistic-concurrency]
files:
  - src/api/routes/opportunities.ts
  - src/api/services/opportunityService.ts
  - src/api/services/stageListService.ts
  - src/api/schemas.ts
  - tests/part1/opportunities.test.ts
  - tests/part1/crossTenantStage.test.ts
  - tests/part1/crossPipelineStage.test.ts
completed: 2026-09-30
---

## What

`POST /opportunities` (201, version 1), `POST /opportunities/:id/move`
(`{ targetStageId, expectedVersion? }` → 200 / 409 / 400 / 404),
`GET /stages/:stageId/opportunities?cursor=&limit=` → `{ items, nextCursor }`.

## Key decisions

- Create validates the stage against BOTH workspace and the named `pipelineId`. The foreign keys
  each pass individually for a mismatched pair, so nothing but this check stops a row whose
  `pipeline_id` and `stage_id` name different pipelines — a row every later listing disagrees about.
- Move is Task 9's `moveOpportunity`, unchanged: manual and bulk writers share one version-bump
  path, which is the only reason `job_items.expected_version` means anything. See
  [[module-api-submission]].
- Tenant comes from `req.workspaceId`, never the body.
- Listing is keyset, not OFFSET. The cost argument (O(N) re-scan per page) is secondary; the
  correctness argument is decisive — under concurrent writes an OFFSET walk silently skips or
  repeats rows and the caller cannot tell.

## Two cursor bugs, both measured

- **Microsecond truncation.** The first implementation put the boundary timestamp through a JS
  `Date`. `timestamptz(6)` is microsecond; `Date` is millisecond. The truncated boundary lands
  BEFORE the row it should resume after, so the page boundary repeats rows: 250-row stage returned
  400 rows and never terminated cleanly. Fixed by carrying `created_at::text` and comparing in raw
  SQL — the cursor never touches `Date`.
- **A test that passed for the wrong reason.** The ties test originally used 5 distinct timestamps
  across 250 rows — groups of exactly 50, so a 100-row page never split a group, and a cursor
  comparing `created_at` alone passed. Changed to 7 timestamps so the boundary lands inside a tied
  group; the id-less comparison then loses 15 rows. The row-value form
  `(created_at, id) > (cursor.created_at, cursor.id)` is what maps onto `idx_opportunities_stage_list`.

- `limit + 1` is the has-more detector, same trick as the submission snapshot's truncation check.
- A malformed cursor is a 400, never a silent restart from page one — a caller mid-walk could not
  distinguish that from real data and would loop.
- Another tenant's stage id is a 404, not an empty listing that confirms it exists.

## Links

- depends-on: module-db-schema, module-db-isolation, module-shared-config
- related-to: module-api-submission, module-api-observability

## Restructured into src/modules/opportunities (Phase 2 refactor, commit 4f90ede)

`opportunityService.ts`, `stageListService.ts` and `routes/opportunities.ts` are gone. The module
now separates four layers: `opportunities.routes.ts` (paths + `validate()` middleware),
`.controller.ts` (HTTP in/out only), `.service.ts` (rules + transaction boundary via
`repository.runInTransaction`), `.repository.ts` (every Prisma call, the two raw statements, row
mapping), plus `.schemas.ts`, `.types.ts`, `.errors.ts`, `.constants.ts`.

Behavior is byte-identical: same statuses, codes, messages (including the curly apostrophe in the
target-stage message) and the id schemas still answer without a `details` list while body/query
schemas include zod's issues.

- Six domain errors replace inline code+message pairs: `InvalidStageError`,
  `OpportunityNotFoundError`, `InvalidTargetStageError`, `VersionConflictError`,
  `StageNotFoundError`, `InvalidCursorError`.
- The cursor codec moved to `shared/http/pagination.ts`; the "valid cursor" guard stayed here.
- `MAX_PAGE_SIZE` (200) and `DEFAULT_PAGE_SIZE` (50) are in `.constants.ts` and the schema's
  `limit` bound now reads the constant.
- Gotcha: nothing above the repository may import `@prisma/client` (ESLint enforces it). The row
  type is re-exported as `OpportunityRecord` from `.types.ts`, deliberately as Prisma's generated
  type — a hand-written copy that drifted by a field would silently change the response body.
- Tests that called `moveOpportunity` directly (`collision`, `retryFailed`, `snapshot`) now call
  `container.opportunitiesService.moveOpportunity`.

11 new service unit tests live in `src/modules/opportunities/__tests__/` and run against a fake
repository in 0.39s with no database — the thing the old module-level Prisma import made
impossible. See [[decision-modular-refactor]].
