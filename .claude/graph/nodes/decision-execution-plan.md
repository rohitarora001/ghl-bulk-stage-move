---
id: decision-execution-plan
type: decision
layer: backend
status: complete
tags: [planning, tdd, superpowers, bulk-job]
files:
  - docs/plans/bulk-stage-move-execution.md
completed: 2026-09-30
---

## What it does
Translates the prose design doc (`~/.claude/plans/lets-start-planning-about-compiled-lobster.md`)
into 18 numbered, TDD-shaped tasks with explicit Produces/Consumes interfaces, `Expected:` lines
per step, and a Review Focus list. This is the file the executing-plans skill runs against.

## Key decisions
- Derived a second plan file rather than editing the design doc: the skill's `task-brief`
  extractor slices on `## Task N` headings, which the prose design doc has none of. The design
  doc stays the binding authority on every architectural decision.
- Ordering deviates from the design doc's Commit Sequencing in exactly one place: the
  single-move *service* lands at Task 9 (with the collision test) instead of with Part 1's HTTP
  routes at Task 13, so `collision.test.ts` drives production code instead of a raw UPDATE.

## Gotchas
- `transitions.job_id` cannot be a foreign key at Task 2 — the `jobs` table does not exist until
  Task 5. It is a plain nullable uuid until then.
- `999_grants.sql` must run on *every* `migrate` invocation, not once: Task 5 creates tables
  after Task 3 granted privileges, and ungranted tables would fail for `app_worker`.

## Acceptance criteria
- [x] Every design-doc decision has a task that implements it
- [x] Pre-flight interface scan done; three conflicts found and ruled on
- [ ] All 18 tasks executed (tracked by the SDD ledger)
