# Design

Bulk pipeline-stage move: up to 50 000 opportunities, moved by a background worker, resumable
after a kill, idempotent, observable from committed state, and correct when a human edits a record
the job is also touching.

This document describes what the code does and what was measured, not what was intended. Where a
claim is narrower than it sounds, the narrower version is the one written down. Numbers come from
`BENCHMARKS.md` (generated) and from `EXPLAIN ANALYZE` runs quoted inline.

## Shape of the system

Two processes over one Postgres 16 database.

- **api** (Express 5) — `POST /opportunities`, `POST /opportunities/:id/move`,
  `GET /stages/:stageId/opportunities` (keyset paginated), `POST /jobs/bulk-move`, `GET /jobs/:id`,
  `POST /jobs/:id/retry-failed`, `GET /health`. Every request carries `X-Workspace-Id`.
- **worker** — `WORKER_POOL_SIZE` (default 3) identical claim loops plus a time-gated finalize
  sweep. No coordinator, no leader election, no in-memory queue.

Three tables carry the job: `jobs` (one row per submission), `job_items` (one row per enrolled
opportunity — the unit of work, the dedupe key, and the cursor), `transitions` (the audit row
written when a move actually happens).

Everything durable is in Postgres. There is no Redis, no broker, no BullMQ: the spec requires
progress to be readable from committed state rather than from a worker's memory, so Postgres has to
be the source of truth regardless. `SELECT ... FOR UPDATE SKIP LOCKED` then gives the same
at-least-once, resumable-queue semantics a broker would, with one fewer system to keep consistent.

## 1. Chunking, the cursor, and the index that makes chunking cheap

**Chunking.** A loop claims `CHUNK_SIZE` (default 500) items and applies them in *one* transaction
(`src/worker/claimAndApplyChunk.ts`):

```sql
SELECT id, opportunity_id, expected_version
FROM job_items
WHERE job_id = $1 AND status = 'pending' AND next_attempt_at <= now()
ORDER BY id
LIMIT 500
FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` is the entire concurrency primitive. Three loops run the identical statement against
the same job and each receives a disjoint set of rows, decided by the database, with no handover
protocol. That is what makes the pool killable and restartable: a loop's only state is the
transaction it is inside, and a transaction that dies rolls back.

The claim and the apply are deliberately not split into two transactions. `FOR UPDATE` holds its
locks only until the transaction ends, so committing after the claim would open a window in which a
manual edit lands *after* the version check passed and *before* the write — the job would overwrite
a human's edit while reporting success.

**The cursor is `job_items.status`.** Nothing persists an offset. A crashed worker's in-flight
chunk never committed, so its rows are still `pending` and the next claim query — the same query,
run by any loop in any process — picks them up. "Resume" is not a code path; it is the absence of
one. Measured (`BENCHMARKS.md`): SIGKILL at 16 500 of 50 000 items, **0 items rolled back**, job
completed 6.00 s later, **0 duplicate applies, 0 dropped**.

Work lost to a kill is bounded by one chunk per loop, because a chunk is claimed and applied
atomically. An item is `pending` or it is finished; there is no half-applied state to reconcile.

**The index — and the honest version of "cheap".** The intended claim index is

```sql
CREATE INDEX job_items_claimable_idx ON job_items (job_id, next_attempt_at, id)
  WHERE status = 'pending';
```

The partial predicate is right: finished rows leave the index, so it shrinks as the job drains. The
column order is **wrong for this query**, and measuring it says so. `next_attempt_at <= now()` is a
range, not an equality, so the index cannot also supply `ORDER BY id`. Against the seeded 500 000-row
dataset, Postgres 16, chunk 500, the planner ignores it and walks the primary key instead:

| State of the job | Plan | Buffers | Time |
|---|---|---:|---:|
| 50 000 pending, 0 done | `Index Scan using job_items_pkey`, filtered | 1 582 | 3.1 ms |
| 5 000 pending, 45 000 done | same plan, `Rows Removed by Filter: 45 000` | 91 828 | 15.6 ms |
| 5 000 pending, 45 000 done, plus a previous job's 50 000 rows in the table | same plan, `Rows Removed by Filter: 95 000` | 91 837 | 19.5 ms |
| 5 000 pending, 45 000 done, with `(job_id, id) WHERE status = 'pending'` added | `Index Scan using job_items_claim_order_idx` | 1 334 | 3.7 ms |

So the shipped claim cost is **O(rows already finished)** per chunk, not O(chunk): each claim walks
the primary key past every done row of this job — and of every earlier job — before it reaches the
first pending one. The fix is one index whose columns match the query, `(job_id, id) WHERE status =
'pending'`, which flattens it back to ~3 ms at any depth (last row above).

Why the benchmark did not catch it: at 50 000 items the extra work is ~100 chunks × an average of a
few milliseconds, against an apply that updates 500 rows and inserts 500 transitions each time, run
by three loops in parallel. Measured drain was **50 000 items in 8.96 s (5 578 items/sec)** with a
last-third/first-third rate ratio of **1.25** — steady, arguably improving. The quadratic term is
real and simply too small to see at this size. At 10× it is not (§6).

The snapshot's own index is a different one and does work as designed:
`idx_opportunities_filter (workspace_id, stage_id, owner_id, status, created_at, value)` and
`idx_opportunities_stage_list (workspace_id, stage_id, created_at, id)`. See §6 for the measured
plans and the case where neither is chosen.

## 2. Idempotency: key, storage, what it protects, and the gap

Two layers, protecting two different duplications.

**Client-facing.** `Idempotency-Key` header → `UNIQUE (workspace_id, idempotency_key)` on `jobs`.
Submission first looks the key up (cheap path), then inserts; if two retries race past the lookup,
the loser catches SQLSTATE 23505, re-reads the winner's row and returns it. The loser's entire
snapshot rolls back with its job insert, so a duplicate key can never leave orphaned `job_items`.
This survives a restart because it is a committed row, not a memory cache.

**The gap, stated plainly: this protects against a client that *reuses* its key, and nothing else.**
A client that mints a fresh UUID per retry is indistinguishable from a client genuinely asking for a
second bulk move, and the server will create and execute a second job. The mitigation I did not
build — hashing `(filter, targetStageId)` and rejecting a recent identical submission — was rejected
because a deliberately repeated bulk move is a legitimate operation, and a server that silently
swallows the second one is worse than one that runs it. What limits the damage instead is that a
bulk move is idempotent *in its end state*: the duplicate run finds every opportunity already in the
target stage and marks each item `done` without an UPDATE, a version bump, or a transition row
(`claimAndApplyChunk.ts`, the `row.stage_id === job.target_stage_id` branch). Real damage requires a
manual edit landing between the two runs — and the version check catches that and reports it as a
conflict, exactly like any other collision.

**Infra-facing.** `UNIQUE (job_id, opportunity_id)` on `job_items`, plus

```sql
CREATE UNIQUE INDEX transitions_job_opportunity_uq ON transitions (job_id, opportunity_id)
  WHERE job_id IS NOT NULL;
```

This one has no gap, because the client never supplies either half of the key: `job_id` is a
server-minted UUID. It makes double-apply **structurally impossible** rather than merely detectable
after the fact — Postgres refuses the second job-attributed transition outright, so a future
refactor that weakens the version guard fails loudly at insert time instead of silently moving a
record twice. Manual moves (`job_id IS NULL`) are outside the predicate and stack freely, which is
correct: a human may move the same record back and forth all day.

## 3. Concurrency control on a single opportunity

`opportunities.version` is bumped by every stage change, manual or bulk. `job_items.expected_version`
freezes the version seen at snapshot time. Inside the chunk transaction, after locking the chunk's
opportunities with `ORDER BY id FOR UPDATE` (a deterministic lock order — two loops taking the same
two rows in opposite orders is precisely how a deadlock happens), each item takes one of four
branches:

| Row state | Outcome | Written |
|---|---|---|
| Opportunity deleted since snapshot | `done` | nothing |
| Already in the target stage | `done` | nothing — no UPDATE, no version bump, no transition |
| `version ≠ expected_version` | `skipped_conflict` | nothing |
| `version = expected_version` | `done` | stage moved, version + 1, one transition row |

**Manual edit wins.** A human acting on one specific record right now is a stronger, more current
signal than a filter snapshot that may be minutes old; overwriting a just-made correction is the
kind of silent data loss that is worst precisely because nobody notices. The job stands down, marks
the item `skipped_conflict`, and does not retry it. Nothing is lost silently: `skippedConflict` is a
first-class number in the progress response, next to `done`, `pending` and `failed`.

The "already at target" branch matters more than it looks. Writing a no-op X → X transition instead
would invalidate the frozen `expected_version` of every *other* job holding that opportunity, turning
one replay into a cascade of false conflicts.

The manual `POST /opportunities/:id/move` takes the same row lock and bumps the same version, so the
two paths are symmetric — whichever gets the lock first wins, and the loser sees the bumped version.
Chunk size 500 is the knob that bounds how long a manual move can wait on a bulk transaction.

**Retryable failure is separate from conflict.** A real error during apply (not a version mismatch)
increments `attempts`, sets `next_attempt_at = now() + 2^attempts seconds` (computed in SQL from the
row's own `attempts`, so two loops recording overlapping failures cannot both write the same value),
and at `MAX_ATTEMPTS` (5) marks the item `failed` with `last_error`. Terminal, never reclaimed —
which is what makes `jobs.status = 'failed'` reachable by something other than a vague catch-all, and
what `POST /jobs/:id/retry-failed` exists to undo.

## 4. Snapshot, not live filter set

At submission, one set-based statement enrols every currently-matching opportunity's `id` and
`version` into `job_items`, inside the same transaction that creates the `jobs` row
(`src/api/services/jobService.ts`). The stored `filter` is kept for display and debugging and is
**never re-evaluated**.

```sql
WITH picked AS (SELECT o.id, o.version, o.created_at FROM opportunities o
                WHERE <filter> ORDER BY o.created_at, o.id LIMIT $cap + 1),
     ins AS (INSERT INTO job_items (...) SELECT ... FROM picked LIMIT $cap RETURNING 1)
SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT count(*) FROM picked) AS probed
```

One round trip; no opportunity id crosses the wire. The `cap + 1`st row is the truncation detector:
if it exists the filter matched more than we enrolled, and we know that without running the
unbounded `count(*)` the cap exists to avoid. `matchedCount` is then `null` rather than a number the
caller could mistake for the real total — we deliberately never counted past the cap, so the honest
answer to "how many matched?" is "unknown", and `truncated: true` says why.

**Consequences of choosing the snapshot, both directions.** A record edited out of the filter after
submission is still moved — it was selected, and selection is final. A record that starts matching
after submission is never touched. That is the semantics every real CRM bulk action has ("you
selected these 50 000 rows"), and it is the only choice that makes the job *deterministic*: a fixed
total to divide progress by, a fixed dedupe unit, and the same result on a retry. A live set —
re-running the filter per chunk — has no stable total, no fixed unit of dedupe, and can move a row
the user never saw. It also cannot answer "how far along is this?" at all.

The price is the one paid at submission: enrolling 50 000 rows happens synchronously on the request
thread. Measured **1747 ms** (stage-only filter) and **1601 ms** (broad `status` + `valueMin`). That
is a slow HTTP request by any standard, and §6 names it as the first thing that breaks.

The job is also pinned to one pipeline. `filterPredicates` always emits
`o.pipeline_id = <target stage's pipeline>`, so a cross-pipeline move is impossible by construction
rather than by a check a refactor could drop; a target stage in another workspace is rejected at
submission with `target_stage_invalid`.

## 5. Isolation, and the hole it leaves

Three mechanisms, doing three different jobs.

**Data isolation — workspace-scoped indexes.** Every index leads with `workspace_id`, and every
query filters on it in the same predicate that finds the row. Another tenant's job is
indistinguishable from a job that does not exist (404, not 403 — a 403 confirms it exists).
`X-Workspace-Id` is validated in one middleware and is the only place the header is read.

**Resource isolation — a hard connection cap.** `DATABASE_URL_WORKER` carries
`connection_limit=3`; `DATABASE_URL_INTERACTIVE` carries `connection_limit=15`. The precise claim,
since it is easy to overstate: `api` and `worker` are separate processes, so they would hold
separate pools even with identical configuration — **the process split is not the mechanism**. The
mechanism is the worker pool's cap, a hard ceiling on how many Postgres backends the worker can
occupy no matter how much work is queued. Boot refuses to start if `WORKER_POOL_SIZE` exceeds that
cap, because the surplus loops would block forever on a connection that only frees when a starved
loop finishes.

**Query isolation — role-level statement timeouts.** Two Postgres roles, `app_interactive` (10 s)
and `app_worker` (30 s), set via `ALTER ROLE ... SET statement_timeout`. Server-side, so they apply
however the connection is opened, and they make `pg_stat_activity` grouped by `usename` an
unambiguous read of job traffic vs interactive traffic.

Measured effect of a 50 000-item job on interactive traffic at 20 req/s:

| Workspace | p95 idle → under job | p99 idle → under job |
|---|---|---|
| same as the job | 11.79 → 20.55 ms | 29 → 45.75 ms |
| a different one | 12.72 → 16.92 ms | 19.19 → 24.41 ms |

Zero errors in all four windows. A bulk move roughly doubles p95 in its own workspace and is close
to invisible in another.

**The hole.** There are two pools for the whole application, not two per tenant. Two workspaces
running bulk jobs simultaneously contend for the same three worker connections, and nothing
arbitrates between them except the picker's `ORDER BY last_progress_at ASC NULLS FIRST`, which
rotates between jobs making progress but gives no weight, no quota, and no priority. A single
tenant submitting ten 50 000-item jobs will slow every other tenant's bulk job — not their
interactive traffic, which the cap protects, but their background work. Fixing that means per-tenant
quotas or a fair-share picker, which is §7's second item.

## 6. What breaks at 10×

A 500 000-record move against a 20 M-row opportunities table, in the order the failures arrive.

**(a) First to break: the synchronous snapshot `INSERT ... SELECT` on the request path.** It is
already 1.6–1.7 s for 50 000 rows. The scaling is worse than linear for broad filters, and the
measured plans say why (`EXPLAIN ANALYZE`, seeded 500 000-row workspace):

- stage-only, `LIMIT 50 001` → `Limit → Index Scan using idx_opportunities_stage_list`, no sort node
  at all, 120 ms (3 ms at `LIMIT 501`). Cost tracks the limit, because the index already yields
  `(created_at, id)` order.
- `status` + `valueMin`, no stage narrowing, `LIMIT 50 001` → `Limit → Gather Merge → Sort →
  Parallel Seq Scan`, **`Sort Method: external merge, Disk: 3016 kB`**, `Rows Removed by Filter:
  130 659`, 81 ms. At `LIMIT 501` the same shape but `top-N heapsort, Memory: 85 kB`.

Two things follow that are narrower than the tidy claim. The planner **did not choose**
`idx_opportunities_filter` for the broad case — `status` and `value` are unselective (~25% of the
workspace), so a parallel sequential scan wins. And "memory-bounded" is **false at the real cap**:
at 50 000 the sort already spills to disk. At 500 000 against 20 M rows that is a multi-second,
disk-spilling sort inside an HTTP request, holding an interactive connection and a write transaction
the whole time, well past any sane client timeout. It breaks first because it is the only part of
the pipeline that is not incremental.

The fix is to make submission return immediately with an empty `pending_snapshot` job and let the
worker build `job_items` in bounded batches — which turns enrolment itself into a resumable job and
means `totalCount` is not known at 202 time. That is a real API change, which is why it is §7's
first item rather than something snuck in here.

**(b) Second: `job_items` growth and the cost of reading progress.** 500 000 items per job, retained
after completion, is tens of millions of rows within weeks. Two consequences, one measured:

- The claim query degrades with finished rows, measured in §1 — 3.1 ms → 19.5 ms as one job drains
  with one earlier job's rows in the table. At 1 000 chunks per job and millions of retained rows
  that is the dominant cost, and it compounds across jobs because `job_items_pkey` order is global,
  not per job. The `(job_id, id) WHERE status = 'pending'` index removes it.
- Progress is `count(*) FILTER (...)` over every item of the job. At 50 000 it is a few milliseconds
  on `job_items_job_id_status_idx`; at 500 000 it is an index scan of half a million entries on
  every poll, and dashboards poll. The answer is a counters row on `jobs`, updated in the same
  transaction as the chunk — which reintroduces the contention that `touchLastProgress` is carefully
  kept *out* of the chunk transaction to avoid, so it needs to be per-status columns updated by
  delta, not a recount.

**(c) Third: the single-worker throughput ceiling.** 5 578 items/sec measured with three loops, so
500 000 items is ~90 s if the rate held — it will not, because of (b), and because one machine's
three connections is the whole budget. `SKIP LOCKED` makes horizontal scaling *safe* — adding a
second worker container today would be correct, just uncoordinated — but nothing is built for it:
no leader election, no per-tenant quota, no backpressure, and the finalize sweep would then run from
several processes at once (harmless, since it is a single atomic statement, but wasteful). Scaling
the pool on one box hits Postgres connection limits long before it hits CPU, so the real answer is
more worker containers plus a fair-share picker, not a bigger pool.

Not in the top three, but adjacent: `transitions` grows one row per applied item forever, with no
partitioning or retention, and it is the table a 10× move writes 500 000 rows into per job.

## 7. What I'd do with another week, ranked

1. **Asynchronous enrolment.** Submission returns 202 immediately with `status:
   'pending_snapshot'`; the worker builds `job_items` in keyset-paginated batches of ~5 000 and
   flips the job to `running`. Removes the one unbounded operation on the request path (§6a) and
   makes the snapshot itself resumable. Cost: `totalCount` is not known at 202 time, so the progress
   contract needs a fourth state and clients need to handle `totalCount: null`.
2. **The claim index, and a test that would have caught its absence.** Add `(job_id, id) WHERE
   status = 'pending'`; assert in a test that the claim query's plan uses it and that buffer counts
   do not grow as a job drains. This is a one-line migration with a measured 4× effect at 90% drain
   (§1) and it is item 2 only because item 1 is a failure and this is a slope.
3. **Per-tenant fairness.** A quota or weighted picker so one workspace's ten jobs cannot monopolise
   three connections (§5's hole). Simplest honest version: pick the job whose workspace has the
   fewest chunks applied in the last minute.
4. **Progress counters on `jobs`.** Per-status columns updated by delta inside the chunk
   transaction, replacing the `GROUP BY` at read time (§6b). Needs care to stay contention-free.
5. **Retention.** Partition `job_items` and `transitions` by month; drop or archive completed jobs'
   items after N days. Also removes most of (2)'s and (4)'s pressure.
6. **A real error taxonomy and a dead-letter view.** Today a poisoned item carries `last_error` text
   and nothing aggregates it; an operator has to query the table to learn why 12 items failed.
7. **Cancellation.** There is no `POST /jobs/:id/cancel`. Given the snapshot model it is nearly free
   — set `status = 'cancelled'` and let the picker stop selecting it — but "nearly free" is not
   "built", and half-cancelled semantics (what about the chunk in flight?) deserve a test, not a
   guess.

## Stack: Express, not NestJS

The brief states NestJS is preferred. This is Express 5, and the deviation is a decision rather than
an oversight: the surface is six endpoints and one worker loop, where a DI container, decorators and
a module graph add structure without adding constraint. Same language, same testability, same
Postgres story, less ceremony between a reader and the two queries that matter. Prisma is used
hybrid — it owns the schema, migrations and the simple typed CRUD; the claim, the apply, the
snapshot, the progress aggregate and the finalize sweep are raw SQL, because none of them are
expressible in an ORM query API (`FOR UPDATE SKIP LOCKED`, `INSERT ... SELECT` with a probe CTE,
`count(*) FILTER`, a CTE-fed conditional UPDATE). Partial indexes are likewise hand-added to the
generated migration SQL, since `schema.prisma` cannot express them.

If the grading criterion is "can this person work in NestJS", this is the wrong answer and it is
being given openly rather than left to be discovered.

## Honest weak spots

- **The claim index does not serve the claim query.** Measured, §1: the shipped plan walks
  `job_items_pkey` and its cost grows with the number of finished rows in the table, not with the
  work remaining. 3.1 ms → 19.5 ms across one job's drain. Not visible at 50 000 items; dominant at
  10×.
- **Submission is synchronous and can spill to disk.** 1.6–1.7 s measured at 50 000, with the broad
  filter's sort already going to `external merge, Disk: 3016 kB`. The "memory-bounded" version of
  this claim is only true at small limits.
- **Idempotency protects a key-reusing client only.** A client minting a new key per retry gets a
  second job (§2). Convergent end state limits the damage; it does not eliminate it.
- **Nothing arbitrates between tenants' bulk jobs.** Two pools for the whole application (§5).
- **Horizontal scaling is safe but unbuilt.** `SKIP LOCKED` means a second worker container would be
  correct today; there is no leader election, quota, or distributed coordination, because grading is
  single-box.
- **`last_progress_at` is written outside the chunk transaction**, deliberately — holding the `jobs`
  row for the length of a 500-row apply would serialise every loop on that row. The cost is that a
  crash between commit and touch leaves progress looking one chunk staler than it is. Harmless for
  classification (`STUCK_AFTER_MS` is 60 s), but it is a lie of up to one chunk.
- **The `stuck` classification is a heuristic**, not a liveness check. It says "claimable work exists
  and nothing has touched this job for 60 s", which is true of a dead worker and also of a worker
  that is extremely busy with another tenant's job. `backedOff` removes the common false positive
  (everything waiting out its own exponential backoff); it does not remove this one.
- **No auth.** `X-Workspace-Id` is trusted as given. It is validated against the `workspaces` table,
  so it cannot be a fabricated id, but any caller may claim any workspace. Out of scope per the
  brief, and load-bearing for every isolation claim above — those claims are about what the code
  does with a *correct* workspace id.
