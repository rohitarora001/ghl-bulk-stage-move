import { interactivePrisma } from '../../db/prismaClients';
import { ApiError } from '../errors';

/**
 * Puts a job's exhausted items back in the queue.
 *
 * This is a replay, not a force. `expected_version` is deliberately left exactly as the snapshot
 * froze it: an item that failed for an unrelated reason and has since been edited by a human must
 * come back as a conflict, not as an overwrite. Refreshing the expected version here would turn
 * an operator's "try that batch again" into a silent revert of someone else's work.
 */

export interface RetryResult {
  jobId: string;
  retriedCount: number;
}

export async function retryFailedItems(
  workspaceId: string,
  jobId: string,
): Promise<RetryResult> {
  return interactivePrisma.$transaction(async (tx) => {
    // Locked, and locked first. The finalize sweep skips jobs whose row is locked, so holding it
    // here is what stops the sweep from re-finalizing this job on a snapshot taken before the
    // items became pending again — see the note on runFinalizeSweep.
    const [job] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM jobs WHERE id = ${jobId}::uuid AND workspace_id = ${workspaceId}::uuid
      FOR UPDATE
    `;
    if (!job) throw ApiError.notFound('job_not_found', 'job not found');

    const retriedCount = await tx.$executeRaw`
      UPDATE job_items
      SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE job_id = ${jobId}::uuid AND status = 'failed'
    `;

    if (retriedCount > 0) {
      // Same transaction as the items, never a follow-up statement: a job left 'failed' with
      // pending items is invisible to the picker, and the work would sit there forever.
      await tx.$executeRaw`
        UPDATE jobs SET status = 'running', error_message = NULL, last_progress_at = now()
        WHERE id = ${jobId}::uuid
      `;
    }

    // Nothing failed ⇒ nothing to do. Deliberately NOT flipping a completed job back to running:
    // a second call must not un-finish a job that finished.
    return { jobId, retriedCount };
  });
}
