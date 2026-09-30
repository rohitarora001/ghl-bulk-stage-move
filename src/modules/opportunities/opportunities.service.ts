import { decodeCursor, encodeCursor } from '@shared/http/pagination';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './opportunities.constants';
import {
  InvalidCursorError,
  InvalidStageError,
  InvalidTargetStageError,
  OpportunityNotFoundError,
  StageNotFoundError,
  VersionConflictError,
} from './opportunities.errors';
import type { OpportunitiesRepository } from './opportunities.repository';
import type {
  CreateOpportunityInput,
  ListStageOpportunitiesInput,
  ListStageOpportunitiesResult,
  MoveOpportunityInput,
  OpportunityRecord,
  StageListCursor,
} from './opportunities.types';

function isStageListCursor(value: unknown): value is StageListCursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as StageListCursor;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.createdAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.createdAt))
  );
}

export interface OpportunitiesService {
  createOpportunity(input: CreateOpportunityInput): Promise<OpportunityRecord>;
  moveOpportunity(input: MoveOpportunityInput): Promise<OpportunityRecord>;
  listStageOpportunities(input: ListStageOpportunitiesInput): Promise<ListStageOpportunitiesResult>;
}

/**
 * Part 1's rules: create a record, move one by hand, and page through a stage.
 *
 * The manual move is the other half of the collision policy. Both writers of
 * `opportunities.stage_id` bump the version — this one and the bulk job's chunk apply — which is
 * what makes `job_items.expected_version` mean anything. If a human moves a record between the
 * job's snapshot and the job's apply, the version the job froze no longer matches and the job
 * stands down: a person acting on one specific record now is a fresher signal than a filter
 * snapshot that may be minutes old.
 */
export function createOpportunitiesService(
  repository: OpportunitiesRepository,
): OpportunitiesService {
  return {
    /**
     * Creates at version 1.
     *
     * The stage is validated against BOTH the workspace and the named pipeline before the insert.
     * A row whose `pipeline_id` and `stage_id` point at different pipelines is not a bad request
     * that failed — it is a row every later listing disagrees about, and the foreign keys alone do
     * not forbid it because each one is individually satisfied.
     *
     * @throws {InvalidStageError} when the stage is not in this workspace and this pipeline.
     */
    async createOpportunity(input) {
      const stageExists = await repository.findStageInPipeline(
        input.workspaceId,
        input.stageId,
        input.pipelineId,
      );
      if (!stageExists) throw new InvalidStageError();

      return repository.create(input);
    },

    /**
     * Moves one opportunity, in one transaction, under a row lock.
     *
     * @throws {OpportunityNotFoundError} when no such row exists in this workspace.
     * @throws {InvalidTargetStageError} when the target is outside the record's own pipeline.
     * @throws {VersionConflictError} when `expectedVersion` no longer matches.
     */
    async moveOpportunity({ workspaceId, opportunityId, targetStageId, expectedVersion }) {
      return repository.runInTransaction(async (tx) => {
        const current = await repository.lockForMove(tx, workspaceId, opportunityId);
        if (!current) throw new OpportunityNotFoundError();

        // Both halves matter. Workspace alone would let a leaked stage id from another tenant pull
        // this record into their pipeline; pipeline alone is meaningless across tenants.
        // Cross-pipeline reassignment is out of scope rather than unimplemented — it would have to
        // decide what happens to `pipeline_id` too.
        const targetIsValid = await repository.stageBelongsToPipeline(
          tx,
          workspaceId,
          targetStageId,
          current.pipelineId,
        );
        if (!targetIsValid) throw new InvalidTargetStageError();

        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          throw new VersionConflictError(expectedVersion, current.version);
        }

        if (current.stageId === targetStageId) {
          // Already there. Bumping the version would invalidate every running job's frozen
          // `expected_version` — turning other jobs' items into conflicts — for a change that did
          // not happen, and would write an X → X audit row that never occurred.
          return repository.findById(tx, opportunityId);
        }

        return repository.applyMove(tx, {
          workspaceId,
          opportunityId,
          fromStageId: current.stageId,
          toStageId: targetStageId,
        });
      });
    },

    /**
     * One keyset page of a stage, oldest first.
     *
     * Not OFFSET. At 500k rows an OFFSET walk re-reads every row it has already returned, so page
     * N costs more than page N-1 — but the correctness problem is worse than the cost: a row
     * inserted, moved into, or moved out of the stage during the walk shifts every later page, and
     * the caller silently skips or repeats rows with no way to notice. A keyset cursor names the
     * last row it saw, so it resumes from a fixed point no concurrent write can move.
     *
     * @throws {StageNotFoundError} when the stage is not in this workspace.
     * @throws {InvalidCursorError} when the cursor does not decode.
     */
    async listStageOpportunities(input) {
      const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

      // Checked against the workspace, so another tenant's stage id reads as a stage that does not
      // exist rather than as an empty listing that confirms it does.
      const stageExists = await repository.findStageInWorkspace(input.workspaceId, input.stageId);
      if (!stageExists) throw new StageNotFoundError();

      let after: StageListCursor | null = null;
      if (input.cursor !== undefined) {
        after = decodeCursor(input.cursor, isStageListCursor);
        if (after === null) throw new InvalidCursorError();
      }

      const page = await repository.listByStage({
        workspaceId: input.workspaceId,
        stageId: input.stageId,
        limit,
        after,
      });

      return {
        items: page.items,
        nextCursor: page.hasMore && page.lastCursor ? encodeCursor(page.lastCursor) : null,
      };
    },
  };
}
