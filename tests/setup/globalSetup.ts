import { applyTestEnv } from './env';
import { migrate } from '../../scripts/migrate';

/**
 * Brings the test database fully up to date once per suite run, through the same runner
 * production uses: roles first, then `prisma migrate deploy`, then grants. Calling `migrate
 * deploy` directly here would leave `app_interactive`/`app_worker` missing, and every test that
 * touches the two capped clients would fail on authentication rather than on its own subject.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  await migrate();
}
