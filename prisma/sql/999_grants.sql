-- Runs AFTER `prisma migrate deploy`, on every `npm run migrate`, because each new migration
-- creates tables that the two application roles would otherwise have no privileges on. Running
-- this once at setup time would leave every later table unreachable for app_worker.
--
-- Both roles get the same table privileges. The thing that differs between them is the
-- statement_timeout and the connection_limit, not the grant matrix — a per-table privilege split
-- would add a maintenance burden without closing any threat this system actually has.
--
-- What is deliberately withheld from both: DELETE, TRUNCATE, and any DDL. Nothing in the API or
-- the worker ever removes a row — a bulk move rewrites `stage_id`, it does not delete — so a
-- role that can delete is strictly more authority than the application needs.

GRANT USAGE ON SCHEMA public TO app_interactive, app_worker;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public
  TO app_interactive, app_worker;

-- job_items.id is a bigserial; inserting the snapshot needs the sequence.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO app_interactive, app_worker;

-- Prisma's own migration bookkeeping is none of the application's business.
REVOKE ALL ON TABLE _prisma_migrations FROM app_interactive, app_worker;
