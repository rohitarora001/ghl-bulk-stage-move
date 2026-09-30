---
id: config-repo-scaffold
type: config
layer: devops
status: in-progress
tags: [git, scaffold, take-home]
files:
  - .gitignore
  - SDE3-Opportunities-Take-Home.pdf
completed: 2026-09-30
---

## What it does
Git repository for GoHighLevel's SDE-3 backend take-home (bulk stage move). Initialised
on `main` with the brief PDF and a Node/TypeScript `.gitignore`; all implementation happens
on the `feat/bulk-stage-move` branch.

## Key decisions
- Feature branch over a linked git worktree: the repo was created empty for this task, so
  there is no pre-existing branch state to protect and a worktree adds indirection with no
  isolation benefit.
- Local Postgres 18 (port 5432) is present but its `postgres` password is unknown; dev/test
  instead use a podman Postgres 16 container on port 55433, which mirrors the
  docker-compose topology the deliverable ships.

## Gotchas
- `docker` is not on PATH; `podman` (5.8.3, WSL machine running) and `docker-compose` v5.5.0
  are, and `podman compose` shells out to the latter. Compose files must be verified with
  `podman compose`, not `docker compose`.

## Acceptance criteria
- [x] Repo initialised, initial commit on `main`, work branch `feat/bulk-stage-move` created
- [x] Container Postgres reachable for tests
- [ ] Application code, tests, docker-compose topology (tracked by later nodes)
