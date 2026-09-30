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
});

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

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
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
