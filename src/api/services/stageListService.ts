import { Prisma } from '@prisma/client';
import { interactivePrisma } from '@shared/database';
import { ApiError } from '../errors';

/**
 * Keyset pagination over a stage's opportunities.
 *
 * Not OFFSET. At 500k rows an OFFSET walk re-reads every row it has already returned on each page,
 * so the cost of page N grows with N — but the correctness problem is worse than the cost: a row
 * inserted, moved into, or moved out of the stage during the walk shifts every later page, and the
 * caller silently skips or repeats rows without any way to notice. A keyset cursor names the last
 * row it saw, so it resumes from a fixed point no concurrent write can move.
 *
 * The cursor carries `id` as well as `created_at` because `created_at` is not unique. With ties,
 * `> created_at` skips the rest of the tied group and `>= created_at` returns it again; the
 * row-value comparison `(created_at, id) > (cursor.created_at, cursor.id)` is exact, and it maps
 * straight onto the `(workspace_id, stage_id, created_at, id)` index.
 *
 * The timestamp travels as Postgres text, never through a JS `Date`. `timestamptz(6)` holds
 * microseconds and `Date` holds milliseconds; round-tripping the boundary through `Date` truncates
 * it, the comparison then lands *before* the row it was supposed to resume after, and the page
 * boundary repeats rows. Measured: with 250 rows at 5 distinct `now()`-derived timestamps, the
 * truncating version returned 400 rows and never terminated cleanly.
 */

export const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

interface Cursor {
  /** Postgres text rendering, microsecond-exact. Deliberately not an ISO string from `Date`. */
  createdAt: string;
  id: string;
}

interface Row {
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
  created_at_key: string;
}

export interface StageOpportunity {
  id: string;
  workspaceId: string;
  pipelineId: string;
  stageId: string;
  name: string;
  value: Prisma.Decimal;
  status: string;
  ownerId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Opaque on purpose. A caller who can read the cursor starts treating it as an API and pins us to
 * this key forever; base64 of a private shape says "this is ours" without pretending to be secure
 * — it carries nothing the caller did not already see in the page it came from.
 */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw ApiError.badRequest('invalid_cursor', 'cursor is not a valid pagination cursor');
  }
  // A malformed cursor is a 400, never a silent restart from the beginning: a caller mid-walk
  // would otherwise get the first page again and loop forever with no error to act on.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Cursor).id !== 'string' ||
    typeof (parsed as Cursor).createdAt !== 'string' ||
    Number.isNaN(Date.parse((parsed as Cursor).createdAt))
  ) {
    throw ApiError.badRequest('invalid_cursor', 'cursor is not a valid pagination cursor');
  }
  return parsed as Cursor;
}

export interface ListStageOpportunitiesInput {
  workspaceId: string;
  stageId: string;
  cursor?: string;
  limit?: number;
}

export interface ListStageOpportunitiesResult {
  items: StageOpportunity[];
  nextCursor: string | null;
}

export async function listStageOpportunities(
  input: ListStageOpportunitiesInput,
): Promise<ListStageOpportunitiesResult> {
  const { workspaceId, stageId } = input;
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  // Checked against the workspace, so another tenant's stage id reads as a stage that does not
  // exist rather than as an empty listing that confirms it does.
  const stage = await interactivePrisma.stage.findFirst({
    where: { id: stageId, workspaceId },
    select: { id: true },
  });
  if (!stage) throw ApiError.notFound('stage_not_found', 'stage not found');

  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const after = cursor
    ? Prisma.sql`AND (created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
    : Prisma.empty;

  // `limit + 1` is the has-more detector: one extra row costs nothing and saves a second count
  // query whose answer would be stale by the time it returned anyway.
  const rows = await interactivePrisma.$queryRaw<Row[]>`
    SELECT id, workspace_id, pipeline_id, stage_id, name, value, status::text AS status,
           owner_id, version, created_at, updated_at, created_at::text AS created_at_key
    FROM opportunities
    WHERE workspace_id = ${workspaceId}::uuid AND stage_id = ${stageId}::uuid
    ${after}
    ORDER BY created_at, id
    LIMIT ${limit + 1}
  `;

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
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
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ createdAt: last.created_at_key, id: last.id }) : null,
  };
}
