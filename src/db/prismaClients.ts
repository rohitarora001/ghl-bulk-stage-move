import { PrismaClient } from '@prisma/client';
import { getConfig } from '../shared/config';

/**
 * Two clients, two roles, two pools — the whole app, not one pool per workspace.
 *
 * `api` and `worker` already run as separate processes, so they would hold separate pools even
 * with identical configuration; the process split alone is therefore *not* the isolation
 * mechanism. The mechanism is `jobPrisma`'s `connection_limit`, a hard cap on how many Postgres
 * backends the worker can ever occupy, no matter how much work is queued. Interactive traffic
 * cannot be starved by a bulk job because the bulk job structurally cannot take more than its
 * share of connections.
 *
 * Neither client's cap scales with tenant count. Two workspaces running bulk jobs at the same
 * time contend for the same small worker pool — a documented gap, acceptable because the
 * requirement is to protect interactive traffic and cross-tenant *data*, not to be fair between
 * concurrent bulk jobs.
 */

function build(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
    // Tests deliberately provoke permission-denied and statement-timeout errors, so they set
    // PRISMA_LOG=silent to keep the suite's output pristine; the errors still reject.
    log:
      process.env.PRISMA_LOG === 'silent'
        ? []
        : process.env.PRISMA_LOG === 'query'
          ? ['query', 'warn', 'error']
          : ['warn', 'error'],
  });
}

let interactive: PrismaClient | undefined;
let job: PrismaClient | undefined;
let sweep: PrismaClient | undefined;

/**
 * The worker URL with its pool forced to a single connection.
 *
 * The sweeper needs one connection and must never wait for one. Sharing `jobPrisma` would put it
 * behind `connection_limit` chunk transactions, each allowed to run for up to 60s — which is
 * exactly the delay the sweeper exists to avoid.
 */
function withSingleConnection(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}

/** Used only by Express request handlers. Larger pool, 10s statement timeout. */
export function getInteractivePrisma(): PrismaClient {
  interactive ??= build(getConfig().databaseUrlInteractive);
  return interactive;
}

/** Used only by the worker loops. Small pool, 30s statement timeout. */
export function getJobPrisma(): PrismaClient {
  job ??= build(getConfig().databaseUrlWorker);
  return job;
}

/** Used only by the finalize sweeper. One connection of its own, held by nothing else. */
export function getSweepPrisma(): PrismaClient {
  sweep ??= build(withSingleConnection(getConfig().databaseUrlWorker));
  return sweep;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([interactive?.$disconnect(), job?.$disconnect(), sweep?.$disconnect()]);
  interactive = undefined;
  job = undefined;
  sweep = undefined;
}

/**
 * Convenience proxies so call sites read `interactivePrisma.opportunity.findMany(...)` without
 * every one of them repeating the getter. Resolution stays lazy — importing this module must not
 * open a connection, or a unit test that never touches the database would fail at import.
 */
function lazyClient(get: () => PrismaClient): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get: (_target, property, receiver) => Reflect.get(get(), property, receiver),
    has: (_target, property) => property in get(),
  });
}

export const interactivePrisma: PrismaClient = lazyClient(getInteractivePrisma);
export const jobPrisma: PrismaClient = lazyClient(getJobPrisma);
export const sweepPrisma: PrismaClient = lazyClient(getSweepPrisma);
