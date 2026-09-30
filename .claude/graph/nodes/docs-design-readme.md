---
id: docs-design-readme
type: docs
layer: backend
status: complete
tags: [design, readme, documentation, weak-spots, explain-analyze]
files:
  - DESIGN.md
  - README.md
completed: 2026-09-30
---

## What it does
The two hand-written deliverables. `DESIGN.md` answers the brief's seven questions (chunking +
cursor + index, idempotency model and its gap, single-record concurrency, snapshot vs live set,
isolation and its hole, what breaks at 10×, ranked next week) plus the Express-not-NestJS deviation
and a weak-spots section. `README.md` documents `docker compose up` as the one command, the by-hand
and benchmark paths, every tunable, the API, and the implemented / not-implemented lists.
Generated numbers live in [[module-benchmarks]]'s `BENCHMARKS.md`, not here.

## Key decisions
- **Written last, after the system was measured.** Every claim in it is either a code reference or a
  number from a run. Where the honest version is narrower than the tidy one, the narrow version is
  what got written.
- **A measured defect goes in the design doc rather than being quietly fixed during a docs task.**
  Section 1's EXPLAIN table is the finding below; recording it in the doc keeps the docs honest and
  leaves the code change to the review fix pass, where a test can prove it.
- README copies the plan's Explicit Exclusions **verbatim**, as a blockquote, so the not-implemented
  list cannot drift from the design authority it came from.
- README's test instructions point at `ghl_test` with a warning: the suite truncates every table
  between cases, so aiming it at a seeded database destroys the dataset.

## The finding recorded in section 1
`job_items_claimable_idx (job_id, next_attempt_at, id) WHERE status = 'pending'` does **not** serve
the claim query. `next_attempt_at <= now()` is a range, so the index cannot also supply `ORDER BY
id`; the planner walks `job_items_pkey` and filters. Measured on the 500 000-row dev dataset,
chunk 500:

| Job state | Plan | Buffers | Time |
|---|---|---:|---:|
| 50 000 pending, 0 done | `job_items_pkey`, filtered | 1 582 | 3.1 ms |
| 5 000 pending, 45 000 done | same, `Rows Removed by Filter: 45 000` | 91 828 | 15.6 ms |
| + an earlier job's 50 000 rows in the table | same, `Rows Removed: 95 000` | 91 837 | 19.5 ms |
| with `(job_id, id) WHERE status = 'pending'` | `job_items_claim_order_idx` | 1 334 | 3.7 ms |

So claim cost is O(rows already finished), across jobs, not O(chunk). Invisible at 50 000 items
(measured drain ratio 1.25, steady) because the apply dominates; dominant at 10×.

## Links
- documents: [[module-worker]], [[module-api-submission]], [[module-db-isolation]],
  [[module-db-schema]], [[module-docker-compose]], [[module-benchmarks]], [[module-api-part1]]
- derived-from: [[decision-execution-plan]]

## Review fix pass (commit 4246c1d)

Both documents now describe what ships rather than what was deferred: §1's index table is framed as
before/after with the shipped index and the plan test that pins it; §2 documents the request
fingerprint and is explicit that it catches one key with two requests and never two keys with one
request; §3 documents the isolation pass; §5 states the worker's real connection count
(`connection_limit` + 1 for the sweeper); §6b's claim-cost bullet is past tense; §7 drops the claim
index and gains "a cheaper isolation pass"; the weak-spots list keeps the index finding as a lesson
about single-size performance claims and adds the isolation pass's N+1 transactions. README: 30
suites / 103 tests, the sweeper's own connection, and the 409 in the API table. `BENCHMARKS.md`
numbers are flagged as measured before the index, so they are the pessimistic ones.

## Rewritten around the architecture (Phase 5 refactor, commit a8ed182)

README now leads with the architecture: a mermaid layer diagram, a "where things live" table
answering the new-joiner questions, the layer rules paired with the ESLint rule enforcing each,
the request and job lifecycles, a recipe for adding a module, the conventions, and an **error-code
table** (which closes the missing-taxonomy gap the review raised).

Every `src/api/...`, `src/worker/...`, `src/db/...` and `src/shared/config.ts` path in README and
DESIGN.md was repointed at the file that now exists. Counts read 32 suites / 129 tests.

DESIGN.md keeps every measurement unchanged — only the file paths moved.

## Benchmark claim corrected (commit e1327cb)

DESIGN.md §1 used to say every number in `BENCHMARKS.md` was measured before the claim index was
added. That stopped being true when the benchmarks were regenerated. It now reports both runs, the
improvement on the submission path, and why the drain comparison across the two runs does not hold.

## Doc audit against the shipped code (commit ce92b7a)

Mechanical check: every `src/…`, `scripts/…`, `tests/…` path named in README, DESIGN and
BENCHMARKS exists, and every `npm run …` they document is a real script. Counts verified: 103
Postgres tests + 26 service unit tests = 129.

Three gaps closed:

- **DESIGN weak spots** now records the compose shutdown defect — `stop --time 15` gives zero
  `worker_shutdown` lines and exit code 1, because `npx` is PID 1. See [[module-worker]]. That
  section is where a reader looks for what is still broken, and the defect was found after it was
  written.
- **README** gained the `ghl_dev` migration instruction (see [[module-benchmarks]]) and a **Checks**
  section — `typecheck`, `lint`, `format`, `build` existed as scripts but appeared in no document.
- **`.prettierignore` added.** README, DESIGN, REFACTOR_NOTES, BENCHMARKS and `.claude/` are
  hand-wrapped prose; Prettier reflows them and turns a one-line fix into a whole-file diff.

## VERIFICATION.md added (commit 84931b7)

A fifth document, linked from README. BENCHMARKS.md is generated by the harness and reports three
measurements; it does not say whether anyone ran the system end to end. VERIFICATION.md records
that: a clean clone driven by `docker compose up` with every endpoint checked live, the small
dataset, and the large one.

Headline numbers from the large run (500k + 5 neighbours, seeded pristine in 39.7s): submission
enrolled 50,000 of 109,466 matched in 714 ms with `matchedCount: null, truncated: true`; drain
9.08s at 5,506 items/sec; interactive p95 during the drain **11.6 ms same workspace vs 11.4 ms in
another** — the isolation claim measured from outside. 100,000 items = 100,000 transitions, 0 wrong
versions, 0 cross-tenant rows, neighbour fingerprint byte-identical.

It also states what the runs did *not* prove — the container kill landed after the job drained, so
killed-at-30,000 rests on `tests/integration/killResume.test.ts`; `retry-failed` was only exercised
on its zero-failure path; and the compose shutdown defect stands.

Note: the brief requires **four** deliverables (repo, README, DESIGN, BENCHMARKS). This is a fifth,
added because the reviewer is told they will try to reproduce the numbers. **The brief asks for no
video** — the only live element is a review call where they pick code and ask why.

