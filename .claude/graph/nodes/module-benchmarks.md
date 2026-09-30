---
id: module-benchmarks
type: module
layer: backend
status: complete
tags: [benchmarks, performance, isolation, throughput, report]
files:
  - scripts/benchmark/common.ts
  - scripts/benchmark/bulkMove.ts
  - scripts/benchmark/interactiveLoad.ts
  - scripts/benchmark/killResume.ts
  - scripts/benchmark/report.ts
  - bench-results/bulk-move.json
  - bench-results/interactive-load.json
  - bench-results/kill-resume.json
  - BENCHMARKS.md
completed: 2026-09-30
---

## What it does
Three benchmarks plus a report generator. `npm run bench:all` runs them in order and regenerates
`BENCHMARKS.md`. Each one starts the real `api` and `worker` entrypoints as separate OS processes,
measures, and stops them — what is measured is the system as it ships, not a function in a loop.

## Key decisions
- **Runs against `ghl_dev`, not `ghl_test`.** `BENCH_PG_*` defaults to `localhost:55433/ghl_dev`,
  the 500 000-row seed from [[module-seed]]. The API listens on 3100, not 3000, so a dev server can
  stay up alongside.
- **`bulkMove.ts` reports a per-second timeseries, not just a total.** A design that re-scans the
  snapshot to find the next chunk decays as the job progresses, and one wall-clock number hides
  that. Steady/degrading is decided from the data: mean rate of the last third over the first.
- **Submission is timed separately, for two filter shapes.** The snapshot `INSERT ... SELECT` runs
  synchronously inside the request, so its latency is a function of the filter's predicate.
- **`interactiveLoad.ts` is open-loop.** A closed loop (send, wait, send) throttles itself exactly
  when the system slows down — it would report less load precisely because the system was
  struggling. Four scenarios: same workspace and a different one, each with and without the job,
  because a with-job number is unreadable without its baseline.
- A load window that ends early is one whose bulk job drained; the load stops with the thing it was
  measuring against rather than averaging the contention away, and the report prints the window
  length so a short row cannot be mistaken for a long one.
- **`report.ts` generates every number from the JSON.** A hand-edited benchmark table is
  indistinguishable from a fabricated one and stops matching the code on the first change that
  moves the numbers. Hardware block comes from `os.cpus()` / `os.totalmem()` / `os.release()`.
- `clearPreviousJobs` deletes the workspace's jobs before each run (cascading to `job_items` and
  their `transitions`) but deliberately does NOT restore stage membership; each run picks the
  current largest stage as its source, so reruns work on the dataset the previous run reshaped.

## Gotchas
- **`toLocaleString()` follows the machine's locale.** The first generated report rendered 500 000
  as "5,00,000". Pinned to en-US through a `num()` helper — a report whose digit grouping depends
  on who ran it silently disagrees with itself across reruns.
- Services are spawned as `node -r ts-node/register <file>`, never the `ts-node` binary: on Windows
  that is a `.cmd` shim needing a shell, and the kill benchmark would kill the shim while the
  worker carried on. Same gotcha as [[module-worker]]'s integration test.
- `matchedCount` is `null` exactly when `truncated` — the probe stops counting at the cap. The
  report prints "capped", because printing 0 would be a lie.
- `killResume.ts` uses SIGKILL on a spawned process rather than `docker kill`; the event under test
  is "the process stopped existing mid-transaction". The container path is covered by
  [[module-docker-compose]].

## Measured 2026-09-30 (AMD Ryzen 7 7435HS, 16 cores, 15.8 GiB, Node v22.15.0, Postgres 16)
- **Submission:** 1747 ms stage-only, 1601 ms broad (`status` + `valueMin`); both capped at 50 000.
- **Drain:** 50 000 items in **8.96 s = 5 578 items/sec**; last-third/first-third ratio **1.25**,
  i.e. steady, not degrading — the evidence for `job_items.status`-as-cursor keeping claim cost flat.
- **Interactive:** p95 11.79 → 20.55 ms in the job's own workspace, 12.72 → 16.92 ms in a different
  one; p99 29 → 45.75 ms and 19.19 → 24.41 ms. Zero errors in all four scenarios.
- **Kill/resume:** 16 500 items committed at the kill, **0 rolled back**, 6.00 s kill → completion,
  **0 duplicate applies, 0 dropped**, final status `completed`.

## Links
- depends-on: [[module-seed]] (the `--large` dataset), [[module-api-submission]],
  [[module-api-observability]] (polls `GET /jobs/:id`), [[module-worker]], [[module-db-isolation]]
  (the `connection_limit=3` cap these numbers are evidence for)

## Phase 1 refactor (commit 05a8167)

`startService()` in `scripts/benchmark/common.ts` spawns with
`node -r ts-node/register -r tsconfig-paths/register <entrypoint>`. The second loader is required
now that the entrypoints import through path aliases; without it every benchmarked process exits
immediately on a module-not-found. Same change, same reason, in
`tests/integration/killResume.test.ts`.

## Phase 4 refactor (commit 4dce5c2)

`startApi()` and `startWorker()` in `scripts/benchmark/common.ts` spawn `src/app/server.ts` and
`src/app/worker.ts`. The measured entrypoints are still the shipped ones — that is the property the
benchmarks exist to preserve.
