import { interactivePrisma } from '../../db/prismaClients';
import { getConfig } from '../../shared/config';
import { ApiError } from '../errors';

/**
 * Progress, computed from committed rows on every call.
 *
 * Nothing here reads a counter the worker keeps: a restart would lose it, a second worker would
 * never see it, and a caller could not tell either failure from real progress. One query does the
 * whole job — the per-status counts, the `backedOff` aggregate, and the `jobs` row — so the four
 * numbers a caller compares against each other come from a single snapshot rather than from four
 * reads a concurrent chunk could land between.
 */

export type JobClassification = 'running' | 'backing_off' | 'stuck' | 'completed' | 'failed';

export interface JobProgress {
  id: string;
  status: string;
  totalCount: number;
  matchedCount: number | null;
  truncated: boolean;
  counts: { done: number; pending: number; skippedConflict: number; failed: number };
  backedOff: number;
  lastProgressAt: Date | null;
  errorMessage: string | null;
  classification: JobClassification;
}

interface ProgressRow {
  id: string;
  status: string;
  total_count: number;
  matched_count: number | null;
  truncated: boolean;
  last_progress_at: Date | null;
  error_message: string | null;
  done: bigint;
  pending: bigint;
  skipped_conflict: bigint;
  failed: bigint;
  backed_off: bigint;
  stale: boolean;
}

/**
 * The three-way classification the design doc calls for, and the reason `backedOff` exists.
 *
 * A stalled `last_progress_at` on its own is ambiguous: it looks identical whether every remaining
 * item is waiting out its own exponential backoff — expected, self-healing, resolves inside the
 * backoff window — or the worker is dead. `backedOff` separates them. `backing_off` is reported
 * regardless of freshness, because when nothing is claimable no worker can be failing to claim it.
 */
function classify(row: ProgressRow): JobClassification {
  if (row.status === 'completed') return 'completed';
  if (row.status === 'failed') return 'failed';

  const pending = Number(row.pending);
  if (pending === 0) return 'running';
  if (Number(row.backed_off) === pending) return 'backing_off';
  // Claimable work exists and nothing has touched this job for the staleness window: a human
  // needs to look at the worker, and saying so is the entire point of the endpoint.
  return row.stale ? 'stuck' : 'running';
}

export async function getJobProgress(
  workspaceId: string,
  jobId: string,
): Promise<JobProgress> {
  const stuckAfterMs = getConfig().stuckAfterMs;

  // LEFT JOIN, not an inner one: a job whose items are all gone (or a zero-match job) must still
  // answer with zeroes rather than 404.
  const [row] = await interactivePrisma.$queryRaw<ProgressRow[]>`
    SELECT
      j.id,
      j.status::text AS status,
      j.total_count,
      j.matched_count,
      j.truncated,
      j.last_progress_at,
      j.error_message,
      count(ji.id) FILTER (WHERE ji.status = 'done') AS done,
      count(ji.id) FILTER (WHERE ji.status = 'pending') AS pending,
      count(ji.id) FILTER (WHERE ji.status = 'skipped_conflict') AS skipped_conflict,
      count(ji.id) FILTER (WHERE ji.status = 'failed') AS failed,
      count(ji.id) FILTER (WHERE ji.status = 'pending' AND ji.next_attempt_at > now())
        AS backed_off,
      -- created_at as the fallback: a job that has never made progress is not automatically
      -- fresh, it is as old as its submission.
      coalesce(j.last_progress_at, j.created_at)
        < now() - (interval '1 millisecond' * ${stuckAfterMs}) AS stale
    FROM jobs j
    LEFT JOIN job_items ji ON ji.job_id = j.id
    WHERE j.id = ${jobId}::uuid AND j.workspace_id = ${workspaceId}::uuid
    GROUP BY j.id
  `;

  // Scoped by workspace in the same predicate that finds the row, so another tenant's job is
  // indistinguishable from one that does not exist.
  if (!row) throw ApiError.notFound('job_not_found', 'job not found');

  return {
    id: row.id,
    status: row.status,
    totalCount: row.total_count,
    matchedCount: row.matched_count,
    truncated: row.truncated,
    counts: {
      done: Number(row.done),
      pending: Number(row.pending),
      skippedConflict: Number(row.skipped_conflict),
      failed: Number(row.failed),
    },
    backedOff: Number(row.backed_off),
    lastProgressAt: row.last_progress_at,
    errorMessage: row.error_message,
    classification: classify(row),
  };
}
