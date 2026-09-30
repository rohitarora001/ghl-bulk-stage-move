import { z } from 'zod';

/**
 * Every tunable the system has, parsed and validated in one place.
 *
 * The two pool-related values are not independent: the worker runs `workerPoolSize` concurrent
 * claim loops, and each loop holds one pooled connection for the full duration of its
 * claim+apply transaction. A `connection_limit` below that count does not degrade gracefully —
 * the extra loops block forever waiting for a connection that only frees when another loop
 * finishes, which it cannot do while starved. So the relationship is validated at boot rather
 * than discovered as a hang.
 */
/** Anything env-shaped: the real `process.env` in production, a literal object in tests. */
export type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface Config {
  databaseUrlAdmin: string;
  databaseUrlInteractive: string;
  databaseUrlWorker: string;
  port: number;
  chunkSize: number;
  bulkMaxItems: number;
  workerPoolSize: number;
  maxAttempts: number;
  sweepIntervalMs: number;
  idleBackoffMs: number;
  claimBackoffMs: number;
  stuckAfterMs: number;
}

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  DATABASE_URL_ADMIN: z.string().min(1),
  DATABASE_URL_INTERACTIVE: z.string().min(1),
  DATABASE_URL_WORKER: z.string().min(1),
  PORT: positiveInt(3000),
  CHUNK_SIZE: positiveInt(500),
  BULK_MAX_ITEMS: positiveInt(50000),
  WORKER_POOL_SIZE: positiveInt(3),
  MAX_ATTEMPTS: positiveInt(5),
  SWEEP_INTERVAL_MS: positiveInt(2000),
  IDLE_BACKOFF_MS: positiveInt(250),
  CLAIM_BACKOFF_MS: positiveInt(500),
  // Longer than the worst backoff a healthy job serves (2^5s at MAX_ATTEMPTS=5), so a job that
  // is merely waiting out its own retries is never reported as needing a human.
  STUCK_AFTER_MS: positiveInt(60000),
});

/**
 * The two observability switches are read leniently, on purpose, and deliberately not part of the
 * schema above.
 *
 * `LOG_LEVEL` and `PRISMA_LOG` change how the process *talks*, not what it does. A typo in either
 * must not stop a worker from draining a job, which is exactly what putting them in the strict
 * schema would do. They also stay uncached: the suite flips `LOG_LEVEL` between cases and expects
 * the next line to obey it.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** The configured log level, or `info` when it is absent or unrecognised. */
export function readLogLevel(env: EnvSource = process.env): LogLevel {
  const raw = (env.LOG_LEVEL ?? 'info').toLowerCase();
  return LOG_LEVELS.find((level) => level === raw) ?? 'info';
}

export type PrismaLogMode = 'silent' | 'query' | 'default';

/** How much Prisma itself should log. Anything unrecognised means the default. */
export function readPrismaLogMode(env: EnvSource = process.env): PrismaLogMode {
  if (env.PRISMA_LOG === 'silent') return 'silent';
  if (env.PRISMA_LOG === 'query') return 'query';
  return 'default';
}

/** Reads `connection_limit` off a Prisma connection string, or null when it is absent. */
export function connectionLimitOf(databaseUrl: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }
  const raw = parsed.searchParams.get('connection_limit');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function loadConfig(env: EnvSource): Config {
  // Strip blanks so an exported-but-empty shell variable reads as absent, not as "".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

  const result = schema.safeParse(present);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }

  const parsed = result.data;
  const workerLimit = connectionLimitOf(parsed.DATABASE_URL_WORKER);
  if (workerLimit === null) {
    throw new Error(
      'DATABASE_URL_WORKER must carry an explicit connection_limit query parameter — ' +
        'the worker pool cap is the isolation mechanism, not a default to be inherited.',
    );
  }
  if (parsed.WORKER_POOL_SIZE > workerLimit) {
    throw new Error(
      `WORKER_POOL_SIZE (${parsed.WORKER_POOL_SIZE}) exceeds the worker connection_limit ` +
        `(${workerLimit}); the surplus loops would block forever waiting for a connection.`,
    );
  }

  return {
    databaseUrlAdmin: parsed.DATABASE_URL_ADMIN,
    databaseUrlInteractive: parsed.DATABASE_URL_INTERACTIVE,
    databaseUrlWorker: parsed.DATABASE_URL_WORKER,
    port: parsed.PORT,
    chunkSize: parsed.CHUNK_SIZE,
    bulkMaxItems: parsed.BULK_MAX_ITEMS,
    workerPoolSize: parsed.WORKER_POOL_SIZE,
    maxAttempts: parsed.MAX_ATTEMPTS,
    sweepIntervalMs: parsed.SWEEP_INTERVAL_MS,
    idleBackoffMs: parsed.IDLE_BACKOFF_MS,
    stuckAfterMs: parsed.STUCK_AFTER_MS,
    claimBackoffMs: parsed.CLAIM_BACKOFF_MS,
  };
}

let cached: Config | undefined;

/**
 * Process-wide config, resolved on first use. Deliberately lazy: importing this module must not
 * throw in a unit test that never touches the database.
 */
export function getConfig(): Config {
  if (cached === undefined) cached = loadConfig(process.env);
  return cached;
}

/** Test seam — forces the next `getConfig()` to re-read `process.env`. */
export function resetConfigCache(): void {
  cached = undefined;
}
