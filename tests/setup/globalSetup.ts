import { execFileSync } from 'node:child_process';
import { applyTestEnv } from './env';

/**
 * Brings the test database's schema up to date once per suite run. `migrate deploy` (not
 * `migrate dev`) so it applies committed migrations exactly as production would, including the
 * hand-added partial indexes.
 */
export default function globalSetup(): void {
  applyTestEnv();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL_ADMIN },
  });
}
