import type { Opportunity } from '@prisma/client';
import { interactivePrisma } from '@shared/database';
import { ApiError } from '../errors';

/**
 * The single manual move — Part 1's endpoint, and the other half of the collision policy.
 *
 * Both writers of `opportunities.stage_id` go through a version bump: this one and the bulk job's
 * chunk apply. That is what makes `job_items.expected_version` mean anything. If a human moves a
 * record between the job's snapshot and the job's apply, the version the job froze no longer
 * matches and the job stands down — the human wins, because a person acting on one specific record
 * now is a fresher signal than a filter snapshot that may be minutes old.
 */

export interface CreateOpportunityInput {
  workspaceId: string;
  pipelineId: string;
  stageId: string;
  name: string;
  value: number;
  ownerId: string;
  status?: 'open' | 'won' | 'lost' | 'abandoned';
}

/**
 * Creates at version 1.
 *
 * The stage is validated against BOTH the workspace and the named pipeline before the insert. A
 * row whose `pipeline_id` and `stage_id` point at different pipelines is not a bad request that
 * failed — it is a row that every later listing disagrees about, and the foreign keys alone do not
 * forbid it because each one is individually satisfied.
 */
export async function createOpportunity(input: CreateOpportunityInput): Promise<Opportunity> {
  const stage = await interactivePrisma.stage.findFirst({
    where: { id: input.stageId, workspaceId: input.workspaceId, pipelineId: input.pipelineId },
    select: { id: true },
  });
  if (!stage) {
    throw ApiError.badRequest(
      'invalid_stage',
      'stageId must name a stage in this workspace and in the named pipeline',
    );
  }

  return interactivePrisma.opportunity.create({
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
}

export interface MoveOpportunityInput {
  workspaceId: string;
  opportunityId: string;
  targetStageId: string;
  /** Optional optimistic guard from a client that read the record first. */
  expectedVersion?: number;
}

export async function moveOpportunity(input: MoveOpportunityInput): Promise<Opportunity> {
  const { workspaceId, opportunityId, targetStageId, expectedVersion } = input;

  return interactivePrisma.$transaction(async (tx) => {
    // `FOR UPDATE` rather than relying on the version predicate alone. The predicate would catch a
    // concurrent change, but only by failing; taking the row lock means this move and a chunk apply
    // touching the same record serialise instead of one of them being told to try again. The lock
    // is held for three short statements, and the worker's chunk is capped at `chunkSize` rows, so
    // neither side waits long on the other.
    const [row] = await tx.$queryRaw<
      { id: string; pipeline_id: string; stage_id: string; version: number }[]
    >`
      SELECT id, pipeline_id, stage_id, version
      FROM opportunities
      WHERE id = ${opportunityId}::uuid AND workspace_id = ${workspaceId}::uuid
      FOR UPDATE
    `;
    // Scoped by workspace, so another tenant's opportunity is indistinguishable from one that does
    // not exist — a 404 either way, with nothing to probe.
    if (!row) throw ApiError.notFound('opportunity_not_found', 'Opportunity not found.');

    // Both halves matter. Workspace alone would let a leaked stage id from another tenant pull this
    // record into their pipeline; pipeline alone is meaningless across tenants. Cross-pipeline
    // reassignment is out of scope rather than unimplemented — it would have to decide what happens
    // to `pipeline_id` too.
    const [stage] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM stages
      WHERE id = ${targetStageId}::uuid
        AND workspace_id = ${workspaceId}::uuid
        AND pipeline_id = ${row.pipeline_id}::uuid
    `;
    if (!stage) {
      throw ApiError.badRequest(
        'invalid_target_stage',
        'targetStageId must name a stage in this workspace and in the opportunity’s pipeline.',
      );
    }

    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw ApiError.conflict(
        'version_conflict',
        'The opportunity changed since it was read; re-read it and retry.',
        { expectedVersion, currentVersion: row.version },
      );
    }

    if (row.stage_id === targetStageId) {
      // Already there. Bumping the version would invalidate every running job's frozen
      // `expected_version` — turning other jobs' items into conflicts — for a change that did not
      // happen, and would write an X → X audit row that never occurred.
      return tx.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    }

    const moved = await tx.opportunity.update({
      where: { id: opportunityId },
      data: { stageId: targetStageId, version: { increment: 1 }, updatedAt: new Date() },
    });
    await tx.transition.create({
      data: {
        opportunityId,
        workspaceId,
        fromStageId: row.stage_id,
        toStageId: targetStageId,
        // Null job: this is a human's move, and the audit trail has to be able to tell them apart.
        jobId: null,
      },
    });
    return moved;
  });
}
