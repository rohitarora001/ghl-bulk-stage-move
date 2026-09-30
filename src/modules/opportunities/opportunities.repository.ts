import { Prisma, type PrismaClient } from '@prisma/client';
import { withTransaction, type DbClient } from '@shared/database';
import type {
  CreateOpportunityInput,
  LockedOpportunity,
  OpportunityRecord,
  StageListCursor,
  StageOpportunity,
} from './opportunities.types';

/** The raw listing row, before it is mapped to the shape the endpoint returns. */
interface StageOpportunityRow {
  id: string;
  workspace_id: string;
  pipeline_id: string;
  stage_id: string;
  name: string;
  value: Prisma.Decimal;
  status: string;
  owner_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  /** `created_at::text` — the microsecond-exact value the next cursor is built from. */
  created_at_key: string;
}

function toStageOpportunity(row: StageOpportunityRow): StageOpportunity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    name: row.name,
    value: row.value,
    status: row.status,
    ownerId: row.owner_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListByStagePage {
  readonly items: StageOpportunity[];
  /** The cursor key of the last row read, for the caller to hand back on the next page. */
  readonly lastCursor: StageListCursor | null;
  /** True when the extra probe row came back, i.e. there is at least one more row after this page. */
  readonly hasMore: boolean;
}

export interface OpportunitiesRepository {
  findStageInPipeline(workspaceId: string, stageId: string, pipelineId: string): Promise<boolean>;
  findStageInWorkspace(workspaceId: string, stageId: string): Promise<boolean>;
  create(input: CreateOpportunityInput): Promise<OpportunityRecord>;
  listByStage(args: {
    workspaceId: string;
    stageId: string;
    limit: number;
    after: StageListCursor | null;
  }): Promise<ListByStagePage>;
  runInTransaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T>;
  lockForMove(
    tx: DbClient,
    workspaceId: string,
    opportunityId: string,
  ): Promise<LockedOpportunity | null>;
  stageBelongsToPipeline(
    tx: DbClient,
    workspaceId: string,
    stageId: string,
    pipelineId: string,
  ): Promise<boolean>;
  findById(tx: DbClient, opportunityId: string): Promise<OpportunityRecord>;
  applyMove(
    tx: DbClient,
    args: {
      workspaceId: string;
      opportunityId: string;
      fromStageId: string;
      toStageId: string;
    },
  ): Promise<OpportunityRecord>;
}

/**
 * Every statement this module runs against Postgres, and nothing else.
 *
 * The transaction-scoped methods take a `DbClient` so the service can compose them into one
 * transaction — the move has to hold a row lock across four statements, and a repository that
 * opened its own transaction per call could not offer that.
 */
export function createOpportunitiesRepository(prisma: PrismaClient): OpportunitiesRepository {
  return {
    async findStageInPipeline(workspaceId, stageId, pipelineId) {
      const stage = await prisma.stage.findFirst({
        where: { id: stageId, workspaceId, pipelineId },
        select: { id: true },
      });
      return stage !== null;
    },

    async findStageInWorkspace(workspaceId, stageId) {
      const stage = await prisma.stage.findFirst({
        where: { id: stageId, workspaceId },
        select: { id: true },
      });
      return stage !== null;
    },

    async create(input) {
      return prisma.opportunity.create({
        data: {
          workspaceId: input.workspaceId,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          name: input.name,
          value: input.value,
          ownerId: input.ownerId,
          ...(input.status ? { status: input.status } : {}),
        },
      });
    },

    async listByStage({ workspaceId, stageId, limit, after }) {
      const keyset = after
        ? Prisma.sql`AND (created_at, id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
        : Prisma.empty;

      // `limit + 1` is the has-more detector: one extra row costs nothing and saves a second count
      // query whose answer would be stale by the time it returned anyway.
      const rows = await prisma.$queryRaw<StageOpportunityRow[]>`
        SELECT id, workspace_id, pipeline_id, stage_id, name, value, status::text AS status,
               owner_id, version, created_at, updated_at, created_at::text AS created_at_key
        FROM opportunities
        WHERE workspace_id = ${workspaceId}::uuid AND stage_id = ${stageId}::uuid
        ${keyset}
        ORDER BY created_at, id
        LIMIT ${limit + 1}
      `;

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toStageOpportunity),
        lastCursor: last ? { createdAt: last.created_at_key, id: last.id } : null,
        hasMore: rows.length > limit,
      };
    },

    async runInTransaction(work) {
      return withTransaction(prisma, work);
    },

    async lockForMove(tx, workspaceId, opportunityId) {
      // `FOR UPDATE` rather than relying on the version predicate alone. The predicate would catch
      // a concurrent change, but only by failing; taking the row lock means this move and a chunk
      // apply touching the same record serialise instead of one of them being told to try again.
      // The lock is held for three short statements, and the worker's chunk is capped at
      // `chunkSize` rows, so neither side waits long on the other.
      const [row] = await tx.$queryRaw<
        { id: string; pipeline_id: string; stage_id: string; version: number }[]
      >`
        SELECT id, pipeline_id, stage_id, version
        FROM opportunities
        WHERE id = ${opportunityId}::uuid AND workspace_id = ${workspaceId}::uuid
        FOR UPDATE
      `;
      if (!row) return null;
      return {
        id: row.id,
        pipelineId: row.pipeline_id,
        stageId: row.stage_id,
        version: row.version,
      };
    },

    async stageBelongsToPipeline(tx, workspaceId, stageId, pipelineId) {
      const [stage] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM stages
        WHERE id = ${stageId}::uuid
          AND workspace_id = ${workspaceId}::uuid
          AND pipeline_id = ${pipelineId}::uuid
      `;
      return stage !== undefined;
    },

    async findById(tx, opportunityId) {
      return tx.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    },

    async applyMove(tx, { workspaceId, opportunityId, fromStageId, toStageId }) {
      const moved = await tx.opportunity.update({
        where: { id: opportunityId },
        data: { stageId: toStageId, version: { increment: 1 }, updatedAt: new Date() },
      });
      await tx.transition.create({
        data: {
          opportunityId,
          workspaceId,
          fromStageId,
          toStageId,
          // Null job: this is a human's move, and the audit trail has to tell them apart.
          jobId: null,
        },
      });
      return moved;
    },
  };
}
