import type { Opportunity, Prisma } from '@prisma/client';
import type { OPPORTUNITY_STATUS } from './opportunities.constants';

/**
 * The persisted opportunity row, re-exported so nothing above the repository imports Prisma.
 *
 * It is deliberately the generated type rather than a hand-written copy: the create and move
 * endpoints serialise this record straight to the client, and a parallel interface that drifted by
 * one field would change the response without anyone noticing.
 */
export type OpportunityRecord = Opportunity;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUS)[number];

export interface CreateOpportunityInput {
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly name: string;
  readonly value: number;
  readonly ownerId: string;
  readonly status?: OpportunityStatus;
}

export interface MoveOpportunityInput {
  readonly workspaceId: string;
  readonly opportunityId: string;
  readonly targetStageId: string;
  /** Optional optimistic guard from a client that read the record first. */
  readonly expectedVersion?: number;
}

/** The row the locked read returns — enough to decide the move, and nothing more. */
export interface LockedOpportunity {
  readonly id: string;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly version: number;
}

/**
 * A page cursor's contents.
 *
 * `createdAt` is Postgres text, microsecond-exact, and deliberately never a JS `Date`:
 * `timestamptz(6)` holds microseconds and `Date` holds milliseconds, so a round trip through
 * `Date` truncates the boundary, the comparison lands *before* the row it should resume after,
 * and the page repeats rows. Measured: 250 rows over 5 timestamps returned 400.
 */
export interface StageListCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** An opportunity as the listing endpoint returns it. */
export interface StageOpportunity {
  readonly id: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly name: string;
  readonly value: Prisma.Decimal;
  readonly status: string;
  readonly ownerId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListStageOpportunitiesInput {
  readonly workspaceId: string;
  readonly stageId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListStageOpportunitiesResult {
  readonly items: StageOpportunity[];
  readonly nextCursor: string | null;
}
