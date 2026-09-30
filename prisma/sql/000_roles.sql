-- Runs BEFORE the Prisma-managed migrations, on every `npm run migrate`. Idempotent.
--
-- Two dedicated login roles, one per traffic class. The split buys three things that a single
-- shared role with two connection strings does not:
--
--   1. `statement_timeout` is pinned with ALTER ROLE ... SET, so it applies however the
--      connection is opened — not dependent on a Prisma-specific URL parameter being honoured
--      identically across versions.
--   2. `pg_stat_activity` grouped by `usename` separates job traffic from interactive traffic
--      directly, instead of relying on the application to set `application_name` on every
--      connection. The benchmarks lean on this.
--   3. Privileges can differ per class if they ever need to.
--
-- The worker's timeout is the looser of the two because one chunk transaction does real
-- multi-statement work across 500 rows; the interactive one is tight because a request that
-- takes ten seconds has already failed its caller.
--
-- NOTE: __INTERACTIVE_PASSWORD__ / __WORKER_PASSWORD__ are substituted by scripts/migrate.ts
-- from the environment. These are local development credentials on a database with no auth
-- layer in front of it; see DESIGN.md for what a production deployment would do instead.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_interactive') THEN
    CREATE ROLE app_interactive LOGIN PASSWORD '__INTERACTIVE_PASSWORD__';
  ELSE
    ALTER ROLE app_interactive WITH LOGIN PASSWORD '__INTERACTIVE_PASSWORD__';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker LOGIN PASSWORD '__WORKER_PASSWORD__';
  ELSE
    ALTER ROLE app_worker WITH LOGIN PASSWORD '__WORKER_PASSWORD__';
  END IF;
END
$$;

ALTER ROLE app_interactive SET statement_timeout = '10s';
ALTER ROLE app_worker      SET statement_timeout = '30s';
