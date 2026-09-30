/**
 * Test-suite defaults for the database URLs.
 *
 * The suite runs against a throwaway Postgres (the `postgres-test` compose service locally, a
 * podman container during development) that is never the seeded demo database, so tests are
 * free to TRUNCATE between cases. Anything already exported wins, so CI can point the same
 * suite somewhere else without editing code.
 */
const HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PORT = process.env.TEST_PG_PORT ?? '55433';
const DB = process.env.TEST_PG_DB ?? 'ghl_test';

export const TEST_ADMIN_URL = `postgresql://postgres:postgres@${HOST}:${PORT}/${DB}`;
export const TEST_INTERACTIVE_URL = `postgresql://app_interactive:app_interactive@${HOST}:${PORT}/${DB}?connection_limit=15`;
export const TEST_WORKER_URL = `postgresql://app_worker:app_worker@${HOST}:${PORT}/${DB}?connection_limit=3`;

export function applyTestEnv(): void {
  process.env.DATABASE_URL_ADMIN ??= TEST_ADMIN_URL;
  process.env.DATABASE_URL_INTERACTIVE ??= TEST_INTERACTIVE_URL;
  process.env.DATABASE_URL_WORKER ??= TEST_WORKER_URL;
  // Prisma's CLI only ever reads `DATABASE_URL`; the app never does.
  process.env.DATABASE_URL ??= process.env.DATABASE_URL_ADMIN;
}

applyTestEnv();
