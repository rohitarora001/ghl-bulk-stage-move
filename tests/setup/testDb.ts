import { PrismaClient } from '@prisma/client';
import './env';

/**
 * Superuser client used only by tests, for setup, truncation and assertions that deliberately
 * sidestep the app's own roles. Production code never uses it.
 */
export const adminPrisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_ADMIN } },
});

/**
 * Empties every application table. Discovered from the catalog rather than hard-coded, so later
 * migrations that add tables are covered without anyone remembering to update this list.
 * `RESTART IDENTITY` matters for `job_items.id`, a bigserial the claim query orders by.
 */
export async function resetDb(): Promise<void> {
  const tables = await adminPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await adminPrisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export interface WorkspaceFixture {
  workspaceId: string;
  pipelineId: string;
  /** Stage ids in `position` order. */
  stageIds: string[];
}

export interface BaseFixture {
  a: WorkspaceFixture;
  b: WorkspaceFixture;
}

/** One pipeline of `stageCount` stages inside a fresh workspace. */
export async function createWorkspace(
  name: string,
  stageCount = 3,
): Promise<WorkspaceFixture> {
  const workspace = await adminPrisma.workspace.create({ data: { name } });
  const pipeline = await adminPrisma.pipeline.create({
    data: { workspaceId: workspace.id, name: `${name} pipeline` },
  });
  const stageIds: string[] = [];
  for (let position = 0; position < stageCount; position += 1) {
    const stage = await adminPrisma.stage.create({
      data: {
        workspaceId: workspace.id,
        pipelineId: pipeline.id,
        name: `${name} stage ${position}`,
        position,
      },
    });
    stageIds.push(stage.id);
  }
  return { workspaceId: workspace.id, pipelineId: pipeline.id, stageIds };
}

/**
 * Two independent workspaces. Nearly every test needs a second tenant to prove the first one's
 * work never leaked, so the fixture always provides one.
 */
export async function seedBaseFixture(): Promise<BaseFixture> {
  return {
    a: await createWorkspace('workspace-a'),
    b: await createWorkspace('workspace-b'),
  };
}

let seq = 0;

/** A single opportunity, with sane defaults and per-call unique ordering. */
export async function createOpportunity(
  fixture: WorkspaceFixture,
  overrides: Partial<{
    stageId: string;
    name: string;
    value: number;
    status: 'open' | 'won' | 'lost' | 'abandoned';
    ownerId: string;
    createdAt: Date;
  }> = {},
): Promise<{ id: string; version: number; stageId: string }> {
  seq += 1;
  const stageId = overrides.stageId ?? fixture.stageIds[0]!;
  const row = await adminPrisma.opportunity.create({
    data: {
      workspaceId: fixture.workspaceId,
      pipelineId: fixture.pipelineId,
      stageId,
      name: overrides.name ?? `opportunity-${seq}`,
      value: overrides.value ?? 1000,
      status: overrides.status ?? 'open',
      ownerId: overrides.ownerId ?? '00000000-0000-4000-8000-000000000001',
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
  return { id: row.id, version: row.version, stageId: row.stageId };
}

export async function disconnectTestDb(): Promise<void> {
  await adminPrisma.$disconnect();
}
