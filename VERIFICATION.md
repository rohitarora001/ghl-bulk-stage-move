# Verification log

What was executed against a running system, and what came back. Distinct from
[BENCHMARKS.md](BENCHMARKS.md), which is generated from the benchmark harness: this file records
manual end-to-end runs — the clean-machine path a reviewer takes, and both seeded datasets driven
through the real API and the real worker.

Every command here is reproducible from the repository. Hardware and Postgres version are in
BENCHMARKS.md.

---

## 1. Clean machine — `docker compose up`

Fresh `git clone` of the pushed repository into an empty directory, then the one documented
command. Nothing from the development working copy was reused, so anything accidentally
`.gitignore`d would have failed here.

```bash
git clone <repo> clean && cd clean
docker compose up --build
```

| Step | Result |
|---|---|
| `postgres`, `postgres-test` | healthy |
| `migrate` | exit 0 |
| `seed` | exit 0 — 5,000 + 2,000 + 2,000 opportunities, 0.9s |
| `test` | exit 0 — **32 suites, 129 tests, 51.8s**, no warnings |
| `api`, `worker` | still running after the suite finished |

The brief asks for one command that brings the app up *and* runs the tests; `api` and `worker`
deliberately stay up afterwards.

### Live API against that stack

| Check | Result |
|---|---|
| `GET /health` | 200 |
| `POST /opportunities` | 201, version 1, value round-tripped |
| `POST /opportunities/:id/move` | 200, version 2 |
| stale `expectedVersion` | 409 `version_conflict`, `details: {expectedVersion: 1, currentVersion: 2}` |
| `POST /jobs/bulk-move` | 202, 296 enrolled |
| replayed `Idempotency-Key` | 200, same `jobId` |
| same key, different filter | 409 `idempotency_key_conflict` |
| `GET /jobs/:id` | `completed` — 296 done / 0 pending / 0 skipped / 0 failed |
| `POST /jobs/:id/retry-failed` | 200 `{retriedCount: 0}` |
| audit integrity | 296 transitions = 296 done items |
| keyset walk to exhaustion | 4 pages, 382 rows, **0 duplicates**, matches the table count exactly |
| error taxonomy, 11 probes | every status as documented in the README table |
| kill worker mid-job | no half-applied rows — every item `done` or `pending` |
| restart worker | job completes; 382 transitions = 382 done items |

---

## 2. Small dataset — 5,000 + 2,000 + 2,000

```bash
DATABASE_URL_ADMIN=…/ghl_small npm run migrate
DATABASE_URL_ADMIN=…/ghl_small npm run seed -- --reset
```

Seeded in **0.7s**. API and worker started as separate processes against it.

| Check | Result |
|---|---|
| create / move / stale version | 201 v1 `12.25` · 200 v2 · 409 |
| bulk move | 255 enrolled, `matchedCount: 255`, `truncated: false` |
| replayed key | same `jobId` |
| drain | 0.93s — 255 done / 0 pending / 0 skipped / 0 failed |
| `retry-failed` | 200 `{retriedCount: 0}` |
| keyset walk | 4 pages, 335 rows, 0 duplicates |
| audit trail | 255 job-attributed transitions **+ 1 with `job_id IS NULL`** — the manual move stays distinguishable from the job's |
| neighbour workspace | `count|sum(version)|md5(stage_ids)` identical before and after |

`matchedCount: 255` here against `null` in the large run below is the truncation rule visible from
the outside: the count is honest when the set fits under the cap, and refused when it does not.

---

## 3. Large dataset — 500,000 + 5 neighbours

```bash
DATABASE_URL_ADMIN=…/ghl_dev npm run migrate
DATABASE_URL_ADMIN=…/ghl_dev npm run seed -- --large --reset
```

Seeded in **39.7s**: 500,000 opportunities in one workspace plus five neighbours of 2,601–4,833,
spread over 18 months.

Stage distribution as seeded — a funnel, not a uniform spread, so stage-scoped filters have
genuinely different selectivities:

| Stage | Rows | | Stage | Rows |
|---|---:|---|---|---:|
| New Lead | 109,466 | | Verbal Commit | 22,427 |
| Contacted | 85,359 | | Contract Sent | 17,739 |
| Qualified | 65,183 | | Closed Won | 30,064 |
| Needs Analysis | 49,736 | | Closed Lost | 27,607 |
| Proposal Sent | 40,107 | | Abandoned | 14,997 |
| Negotiation | 29,818 | | On Hold | 7,497 |

### 50,000-row bulk move, New Lead → Qualified

| Measure | Result |
|---|---|
| submission (109,466 rows matched the filter) | 714 ms — **50,000 enrolled**, `truncated: true`, `matchedCount: null` |
| drain | **9.08s — 5,506 items/sec** |
| progress curve | 0 → 30,000 at 4.8s → 50,000 at 9.1s; linear, no stall |
| final counts | 50,000 done / 0 pending / 0 skipped / 0 failed |
| interactive p95 **during** the drain | **11.6 ms** same workspace · **11.4 ms** different workspace · 0 errors |
| integrity, both large jobs | 100,000 items = 100,000 transitions, **0 rows at the wrong version**, **0 cross-tenant transition rows** |
| neighbour workspace | fingerprint byte-identical before and after |

The interactive numbers are the isolation claim measured from the outside: a 50,000-row job
saturating three worker connections moved the same workspace's p95 by a fraction of a millisecond
against a neighbour tenant's, because the worker's `connection_limit` caps what it can ever take.

---

## Known gaps in this log

- **The mid-flight kill in section 1 drained before the kill landed**, so the container test proves
  "no limbo, no double-apply" rather than "killed at 30,000 of 50,000". That specific scenario is
  covered by `tests/integration/killResume.test.ts`, which SIGKILLs a real worker process at 15,000
  of 50,000, and by the kill/resume benchmark.
- **`retry-failed` was exercised on its zero-failure path only.** Producing genuinely failed items
  live means poisoning a row until it exhausts `MAX_ATTEMPTS`; `tests/part2/retryFailed.test.ts`
  does exactly that and asserts the items return to `pending` with `attempts = 0`.
- **The graceful SIGTERM drain still does not run under compose.** `stop --time 15` produces no
  `worker_shutdown` line and exit code 1, because the service command is `npx ts-node …` and `npx`
  is PID 1. Data is unaffected — a killed chunk rolls back. See DESIGN.md's weak-spots section.
