---
id: module-worker
type: module
layer: backend
status: complete
tags: [worker, skip-locked, transaction, optimistic-concurrency, poison-chunk, backoff, finalize-sweep, read-committed]
files:
  - src/worker/claimAndApplyChunk.ts
  - src/worker/queries.ts
  - src/worker/index.ts
  - tests/setup/jobFixtures.ts
  - tests/part2/chunk.test.ts
  - tests/part2/alreadyAtTarget.test.ts
  - tests/part2/poisonChunk.test.ts
  - tests/part2/drainedJobFinalizes.test.ts
  - tests/part2/finalizeRace.test.ts
  - tests/part2/picker.test.ts
  - tests/part2/resume.test.ts
  - tests/part2/collision.test.ts
  - tests/part2/concurrentLoops.test.ts
completed: 2026-09-30
---

## What

`workerPoolSize` identical claim loops, no coordinator. Each iteration: time-gated finalize sweep →
`pickJobWithClaimableWork` → `claimAndApplyChunk` (one transaction) → `touchLastProgress`.
`runLoop(loopId, signal, prisma = jobPrisma)` returns only on abort; `startWorker()` spawns the pool
and aborts on SIGTERM/SIGINT. `job_items.status` IS the cursor — nothing else is persisted.

## Key decisions

- **One transaction for claim + apply.** `FOR UPDATE SKIP LOCKED` holds locks only to transaction
  end; committing between claim and apply would release them in the gap, letting a manual edit land
  after the version check passed so the job overwrites it while reporting success. It would also
  manufacture false `skipped_conflict`s — the second transaction re-reads a version its own first
  transaction no longer has a claim on.
- `timeout: 60_000, maxWait: 30_000`. Prisma's 5s/2s defaults roll back a 500-row chunk that is
  making progress.
- `SELECT ... FROM opportunities WHERE id = ANY(...) ORDER BY id FOR UPDATE` — deterministic lock
  order makes deadlock between loops impossible, not merely unlikely. That read also supplies
  `from_stage_id`, so the audit row records where the move actually started.
- **Three-way partition**, not two: already-at-target rows are excluded from the mutation entirely
  (no UPDATE, no version bump, no transition). A replayed job is then a true no-op for them instead
  of invalidating other jobs' frozen `expected_version` and writing a fake X → X transition.
  Decided by stage, never by version.
- **Tiered failure.** Claim throws ⇒ nothing claimed ⇒ nothing penalised (`claim-error`). Apply
  throws ⇒ `recordChunkFailure` in a FRESH transaction after the rollback (recording inside the
  failed one would roll back with it and the poison chunk would spin at full speed forever).
- `recordChunkFailure` is guarded `AND status = 'pending'` and computes the backoff in SQL from the
  row's own `attempts` (`now() + interval '1 second' * power(2, least(attempts, 10))`), so two loops
  cannot read the same value and write the same next attempt. Past `MAX_ATTEMPTS` ⇒ terminal
  `failed`, never reclaimed.
- `touchLastProgress` runs AFTER the commit, never inside: holding the `jobs` row for a 500-row
  apply would serialise every loop on that row and turn SKIP LOCKED into a queue. Called on
  `apply-error` too — stale progress sends every loop back to the same poisoned job.
- Picker is scoped to jobs with *claimable* work (`EXISTS ... pending AND next_attempt_at <= now()`),
  ordered `last_progress_at ASC NULLS FIRST`. Status-only scoping would hand back an all-backed-off
  job forever and starve everything behind it.
- Sweep is **time-gated, not idle-gated**, on ONE process-wide `nextSweepAt` (per-loop clocks would
  sweep `workerPoolSize`× the configured rate; the slot is claimed before the await). Idle-gating
  leaves a small drained job at `running` for as long as a big job keeps the loops busy — and the
  progress endpoint reports committed state.

## Gotcha — measured Postgres behaviour, beyond the design doc

The folded single-statement sweep was **not sufficient on its own**. Under READ COMMITTED, an UPDATE
that blocks on a row another transaction is writing re-evaluates its WHERE clause against the new row
version when it resumes, but the **subqueries in that clause still run against the statement's
original snapshot**. Measured: a writer holding the `jobs` row while inserting a `pending` item made
the plain UPDATE resume, see `status = 'running'` on the fresh tuple, miss the now-committed pending
row, and mark the job `completed` — a claimable item stranded in a job the picker will never look at
again. Fix: candidate CTE takes `FOR UPDATE SKIP LOCKED`, so the sweep never resumes on a stale
snapshot; the next sweep re-reads from scratch.

Consequence, binding on Task 10: **`POST /jobs/:id/retry-failed` must reset `jobs.status` to
`running` in the same transaction that makes items `pending`.** A bare insert/flip with no `jobs`
write cannot be serialised against the sweep at all — it is invisible to any snapshot taken before it
commits.

## Resume (Task 8, no production change)

A job killed after two of four chunks resumes by claiming whatever is still `pending` — there is no
persisted offset to go stale. Verified: every item ends `done` with `attempts = 0`, every
opportunity's `version` bumped exactly once, exactly one transition each, and a late chunk call
against a finished job claims 0 rows and changes nothing.

## Collision policy (Task 9), verified end to end

Manual move first ⇒ item `skipped_conflict`, `attempts` still 0 (a conflict is a decision, not a
transient failure), record left at the human's target with a single version bump, and zero
transitions carrying this `job_id`. Manual move to the job's own target ⇒ `done`, not conflict. The
collision is produced by `opportunityService.moveOpportunity`, not a raw UPDATE — a policy that only
holds when the test writes the collision by hand is not a policy.

## Concurrency proof (Task 10) — and what it cannot prove

Aggregate test: 2500 items, 4 staggered loops, no manual edits — all `done`, zero
`skipped_conflict`, one transition each, one version bump each.

**Measured, contradicts the plan:** a two-transaction split reports **zero** conflicts, not the
non-zero the plan predicted. Loops genuinely DO double-claim the same `job_items` under a split
(logged: two claims both starting at ids 1, 51, 151, 251) — the **already-at-target bucket absorbs
the second claimant**, since by the time it takes its locked read the row is already in the target
stage, so the item lands `done` instead of `skipped_conflict`. The no-manual-edit scenario is blind
to a split at any scale. Also: loops started in the same millisecond run phase-aligned and never
overlap at all; staggering is what produces interleaving.

So the boundary is pinned by a second, deterministic test: a blocker transaction holds one of the
chunk's opportunities, the chunk is provably mid-apply, and a competing claim query must return
**zero** rows. Under the canonical split (claim alone in transaction one) it returns all of them.

## Links

- depends-on: module-db-schema, module-db-isolation, module-shared-config
- related-to: module-api-submission (consumes the snapshot it writes)

## Real-process kill/resume proof (Task 16)

`tests/integration/killResume.test.ts` spawns `src/worker/index.ts` as a real OS process
(`node -r ts-node/register`, NOT the `ts-node` binary — on Windows that is a `.cmd` shim needing a
shell, so SIGKILL would kill the shim and leave the worker running), lets it commit a fifth of a
4000-item job, SIGKILLs it, then starts a fresh process and requires it to finish.

Why this exists alongside `tests/part2/resume.test.ts`: the in-process test unwinds its transaction
through the client library, while SIGKILL unwinds nothing — Postgres discovers a dead connection
and aborts the transaction itself. Different code paths; the second is the production one.

**Measured:** 4000 items, CHUNK_SIZE 25, pool 3. After the kill every item was either `done` or
`pending` — sum exactly 4000, zero `skipped_conflict`, zero `failed` — so no item sits in limbo.
`last_progress_at` did not move across a 1.5s window with the process gone. The fresh process
finished all 4000 with zero rows from
`SELECT opportunity_id FROM transitions WHERE job_id=$1 GROUP BY opportunity_id HAVING count(*)>1`
and exactly 4000 transitions. Whole test 5.7s.

**Teeth verified by removal, not by a natural RED** — the entrypoint was already spawnable from
Task 8, so the test passed on first run. Deleting `AND status = 'pending'` from the claim query
makes it FAIL: the restarted worker re-claims applied items, `transitions_job_opportunity_uq`
rejects every duplicate, and the job makes no forward progress for the full 120s timeout.
Related: [[module-docker-compose]] runs this same entrypoint as the `worker` service.

## Measured: the claim index does not serve the claim query (found while writing DESIGN.md)
`job_items_claimable_idx (job_id, next_attempt_at, id) WHERE status = 'pending'` cannot supply
`ORDER BY id` — `next_attempt_at <= now()` is a range predicate, so the sort key is unreachable
after it. The planner walks `job_items_pkey` and filters instead, which means every claim skips
past every already-finished row in the table, this job's and every earlier job's:
3.1 ms / 1 582 buffers at 0 done → 15.6 ms / 91 828 buffers at 45 000 done → 19.5 ms with a prior
job's 50 000 rows also present. Adding `(job_id, id) WHERE status = 'pending'` restores
3.7 ms / 1 334 buffers at the same depth.

Claim cost is therefore O(rows already finished), not O(chunk), and it compounds across jobs.
[[module-benchmarks]] did not catch it: the apply (500 updates + 500 transitions, three loops)
dominates at 50 000 items, and `clearPreviousJobs` empties the table before each run. Full table in
[[docs-design-readme]] §1. The index change belongs to the review fix pass, with a test that asserts
the plan.

## Review fix pass (commit 4246c1d)

Two defects the 94-test suite never exercised, both found by the whole-branch review.

**Poison-chunk blast radius.** `recordChunkFailure` was called with the whole claimed set, so one
unapplicable row charged an attempt to its 499 chunkmates and, after `MAX_ATTEMPTS` passes, the job
reached `failed` with nothing moved. `claimAndApplyChunk` now takes a `limit` parameter; an apply
failure with more than one claimed item runs an isolation pass — the same claim re-run with
`LIMIT 1`, once per claimed item — so each row is judged in its own transaction and only the
offender is penalised. A one-item chunk cannot trigger the pass, which bounds the recursion at one
level. `tests/part2/poisonIsolation.test.ts` poisons one row with a real
`transitions_job_opportunity_uq` violation rather than an injected throw.

**Sweep gated on loop iterations.** `maybeSweep` ran at the top of `runLoop`, so a job that drained
while every loop sat inside a chunk kept reporting `running` for up to the 60s transaction timeout.
The sweep is now `runSweepLoop` — its own loop, its own timer, and `sweepPrisma`
(`connection_limit=1`, see [[module-db-isolation]]) so it never queues behind a chunk.
`resetSweepClock` is gone; `concurrentLoops` and `drainedJobFinalizes` start the sweeper explicitly.

**The claim index shipped.** `job_items_claim_order_idx (job_id, id) WHERE status = 'pending'` is in
the migrations, and `tests/part2/claimPlan.test.ts` builds a 50 000-item job at 90% drain and asserts
the claim's `EXPLAIN` names it with zero rows discarded by filter. Dropping the index makes that test
report `job_items_pkey`. `job_items_claimable_idx` stays for the picker's `EXISTS`.

## Restructured (Phase 4 refactor, commit 4dce5c2) — src/worker/ is gone

| Old | New |
|---|---|
| `worker/queries.ts` + the SQL inside `claimAndApplyChunk` | `modules/bulk-move/bulk-move.worker.repository.ts` |
| the chunk decisions, two failure tiers, isolation pass | `modules/bulk-move/bulk-move.worker.service.ts` |
| the loop body | `modules/bulk-move/jobs/bulk-stage-move.processor.ts` |
| the sweep body | `modules/bulk-move/jobs/finalize-sweep.processor.ts` |
| `sleep`, the never-exit rule | `shared/worker-runtime/{sleep,pollingLoop}.ts` |
| `runLoop`, `runSweepLoop`, `startWorker` | `app/worker.ts` |
| — | `src/jobs/registry.ts` maps the two job kinds to their processors |

The worker repository is deliberately separate from the API's: different role, different pool
(`app_worker`, capped), and transaction boundaries that are load-bearing for correctness.

- `runLoop(loopId, signal, prisma?)` and `runSweepLoop(signal, prisma?)` kept their signatures, so
  the concurrency tests changed only their import path.
- Gotcha: log lines are part of the contract here. `sweep_error` stays a **warning**, which is why
  `finalize-sweep.processor.ts` catches its own failures instead of letting `runPollingLoop`'s
  error path (which logs at `error`) take them. `loop_started`/`loop_stopped`/`loop_error` and
  `sweeper_started`/`sweeper_stopped` come from the loop's `name`.
- Tests that drove `claimAndApplyChunk`/`queries` now use `workerFor(client)` from
  `tests/setup/workerFixtures.ts`, which wires the same service over any client.
- `src/app/worker.ts` is the spawned entrypoint for `tests/integration/killResume.test.ts` and for
  [[module-benchmarks]]; both pass `-r tsconfig-paths/register`.

## Graceful shutdown: measured at last (commit ee5ee91)

The SIGTERM drain in `app/worker.ts` has never actually executed under compose. `podman stop
--time 15` on the running worker logged **no** `worker_shutdown`, `loop_stopped` or
`sweeper_stopped` line and exited **1**: `npx` is PID 1 and the signal kills the Node child before
the handler runs. Items were all `done`, nothing in limbo, so the cost is shutdown noise and a
wrong exit code, not correctness.

Recorded rather than fixed — changing the launch command is a behavior change. See
[[module-docker-compose]].
