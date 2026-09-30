import { adminPrisma, createOpportunity, type WorkspaceFixture } from './testDb';

/**
 * Builds a job and its snapshot the way submission would, without going through the HTTP layer.
 * The worker tests are about what happens to committed state, so they set that state up directly
 * rather than depending on the API's behaviour to arrange their preconditions.
 */

export interface EnrolledJob {
  jobId: string;
  targetStageId: string;
  opportunityIds: string[];
}

let keySeq = 0;

export async function enrollJob(
  fixture: WorkspaceFixture,
  options: {
    targetStageId: string;
    /** Rows to enrol, with the version to freeze as `expected_version`. */
    opportunities: { id: string; version: number }[];
    idempotencyKey?: string;
  },
): Promise<EnrolledJob> {
  keySeq += 1;
  const job = await adminPrisma.job.create({
    data: {
      workspaceId: fixture.workspaceId,
      idempotencyKey: options.idempotencyKey ?? `job-fixture-${keySeq}`,
      filter: {},
      targetStageId: options.targetStageId,
      totalCount: options.opportunities.length,
      matchedCount: options.opportunities.length,
    },
  });
  if (options.opportunities.length > 0) {
    await adminPrisma.jobItem.createMany({
      data: options.opportunities.map((opportunity) => ({
        jobId: job.id,
        opportunityId: opportunity.id,
        expectedVersion: opportunity.version,
      })),
    });
  }
  return {
    jobId: job.id,
    targetStageId: options.targetStageId,
    opportunityIds: options.opportunities.map((opportunity) => opportunity.id),
  };
}

/** `count` opportunities in `stageIds[0]`, enrolled in a job targeting `stageIds[1]`. */
export async function enrollFreshOpportunities(
  fixture: WorkspaceFixture,
  count: number,
  overrides: { sourceStageId?: string; targetStageId?: string } = {},
): Promise<EnrolledJob> {
  const sourceStageId = overrides.sourceStageId ?? fixture.stageIds[0]!;
  const targetStageId = overrides.targetStageId ?? fixture.stageIds[1]!;
  const opportunities = [];
  for (let index = 0; index < count; index += 1) {
    opportunities.push(await createOpportunity(fixture, { stageId: sourceStageId }));
  }
  return enrollJob(fixture, { targetStageId, opportunities });
}
