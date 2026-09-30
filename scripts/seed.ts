import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

/**
 * Set-based seeding. Every opportunity batch is one `INSERT ... SELECT ... generate_series`
 * statement, never a per-row loop: the large dataset is 500 000 rows, and a round trip per row
 * would take hours where this takes seconds.
 */

/** The PDF names twelve stages, not the six in its illustrative example. */
export const DEFAULT_STAGE_NAMES = [
  'New Lead',
  'Contacted',
  'Qualified',
  'Needs Analysis',
  'Proposal Sent',
  'Negotiation',
  'Verbal Commit',
  'Contract Sent',
  'Closed Won',
  'Closed Lost',
  'Abandoned',
  'On Hold',
] as const;

/**
 * Relative weights per stage, in position order — a funnel, with volume concentrated early and
 * thinning towards the closed stages. Real pipelines look like this, and a uniform distribution
 * would make every stage-scoped filter match the same number of rows, which is a poor test of
 * whether the filter index is doing any work.
 */
const STAGE_WEIGHTS = [220, 170, 130, 100, 80, 60, 45, 35, 60, 55, 30, 15];

/** Enough distinct owners that an owner filter is selective but not unique per row. */
const OWNER_COUNT = 50;

const OPPORTUNITY_STATUSES = ['open', 'won', 'lost', 'abandoned'] as const;

/** One statement per batch; 50k keeps each transaction's WAL footprint sane. */
const BATCH_SIZE = 50_000;

export interface SeedWorkspaceOptions {
  name: string;
  opportunityCount: number;
  stageNames?: readonly string[];
  /** Reuse a fixed owner pool across workspaces when the caller wants cross-workspace overlap. */
  ownerIds?: readonly string[];
}

export interface SeededWorkspace {
  workspaceId: string;
  pipelineId: string;
  /** Stage ids in `position` order. */
  stageIds: string[];
  opportunityCount: number;
}

export function generateOwnerIds(count = OWNER_COUNT): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

/**
 * Builds the weighted `CASE` that maps a `generate_series` index onto a stage id.
 *
 * The weights are turned into cumulative bucket boundaries over a single `random()` draw, so the
 * whole distribution is one scalar expression evaluated inside the insert — no client-side
 * shuffling, no second pass to rebalance.
 */
function stageCaseExpression(stageIds: string[]): string {
  const weights = STAGE_WEIGHTS.slice(0, stageIds.length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0;
  const branches = stageIds.slice(0, -1).map((stageId, index) => {
    cumulative += weights[index] ?? 0;
    return `WHEN bucket < ${(cumulative / total).toFixed(6)} THEN '${stageId}'::uuid`;
  });
  return `CASE ${branches.join(' ')} ELSE '${stageIds[stageIds.length - 1]}'::uuid END`;
}

export async function seedWorkspace(
  prisma: PrismaClient,
  options: SeedWorkspaceOptions,
): Promise<SeededWorkspace> {
  const stageNames = options.stageNames ?? DEFAULT_STAGE_NAMES;
  const ownerIds = options.ownerIds ?? generateOwnerIds();

  const workspace = await prisma.workspace.create({ data: { name: options.name } });
  const pipeline = await prisma.pipeline.create({
    data: { workspaceId: workspace.id, name: `${options.name} pipeline` },
  });
  await prisma.stage.createMany({
    data: stageNames.map((name, position) => ({
      workspaceId: workspace.id,
      pipelineId: pipeline.id,
      name,
      position,
    })),
  });
  const stages = await prisma.stage.findMany({
    where: { pipelineId: pipeline.id },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  const stageIds = stages.map((stage) => stage.id);

  const stageCase = stageCaseExpression(stageIds);
  const ownerArray = `ARRAY[${ownerIds.map((id) => `'${id}'::uuid`).join(',')}]`;
  const statusArray = `ARRAY[${OPPORTUNITY_STATUSES.map((s) => `'${s}'`).join(',')}]::opportunity_status[]`;

  let remaining = options.opportunityCount;
  let offset = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, BATCH_SIZE);
    // `bucket` is drawn once per row and reused by the stage CASE, so the funnel weights hold.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO opportunities
        (workspace_id, pipeline_id, stage_id, name, value, status, owner_id, version, created_at, updated_at)
      SELECT
        '${workspace.id}'::uuid,
        '${pipeline.id}'::uuid,
        ${stageCase},
        'Opportunity ' || (${offset} + g)::text,
        round((random() * 49500 + 500)::numeric, 2),
        (${statusArray})[1 + floor(random() * ${OPPORTUNITY_STATUSES.length})::int],
        (${ownerArray})[1 + floor(random() * ${ownerIds.length})::int],
        1,
        created_at,
        created_at
      FROM (
        SELECT g, random() AS bucket, now() - (random() * interval '18 months') AS created_at
        FROM generate_series(1, ${size}) AS g
      ) AS src
      `,
    );
    remaining -= size;
    offset += size;
  }

  // Fresh planner statistics, so the first benchmark run is not measuring a cold optimiser
  // choosing a sequential scan over the filter index.
  await prisma.$executeRawUnsafe('ANALYZE opportunities');

  return {
    workspaceId: workspace.id,
    pipelineId: pipeline.id,
    stageIds,
    opportunityCount: options.opportunityCount,
  };
}

/** The demo dataset `docker compose up` seeds: small enough to finish in seconds. */
export const SMALL_DEMO = { primary: 5_000, secondary: 2_000, secondaryCount: 2 };

/** The benchmark dataset: one large workspace plus five small neighbours to prove isolation. */
export const LARGE_DEMO = { primary: 500_000, secondaryMin: 2_000, secondaryMax: 5_000, secondaryCount: 5 };

export async function seedAll(prisma: PrismaClient, large: boolean): Promise<void> {
  const started = Date.now();
  const shared = generateOwnerIds();

  const primaryCount = large ? LARGE_DEMO.primary : SMALL_DEMO.primary;
  const primary = await seedWorkspace(prisma, {
    name: large ? 'Acme Corp (large)' : 'Acme Corp',
    opportunityCount: primaryCount,
    ownerIds: shared,
  });
  process.stdout.write(
    `seeded ${primaryCount} opportunities into workspace ${primary.workspaceId}\n`,
  );

  const neighbours = large ? LARGE_DEMO.secondaryCount : SMALL_DEMO.secondaryCount;
  for (let index = 0; index < neighbours; index += 1) {
    const count = large
      ? LARGE_DEMO.secondaryMin +
        Math.floor(Math.random() * (LARGE_DEMO.secondaryMax - LARGE_DEMO.secondaryMin))
      : SMALL_DEMO.secondary;
    const neighbour = await seedWorkspace(prisma, {
      name: `Neighbour ${index + 1}`,
      opportunityCount: count,
      ownerIds: shared,
    });
    process.stdout.write(`seeded ${count} opportunities into workspace ${neighbour.workspaceId}\n`);
  }

  process.stdout.write(`seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) throw new Error('DATABASE_URL_ADMIN is required to seed');

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (args.has('--reset')) {
      // Repeatable local runs: wipe application data, keep the schema and the roles. The table
      // list is discovered rather than written out, so a migration that adds a table does not
      // silently leave stale rows behind in a database the operator was told is reset.
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
      `;
      if (tables.length > 0) {
        const list = tables.map((table) => `"${table.tablename}"`).join(', ');
        await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
      }
      process.stdout.write(`reset: ${tables.length} tables truncated\n`);
    }
    if (args.has('--skip-seed')) return;
    await seedAll(prisma, args.has('--large'));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
