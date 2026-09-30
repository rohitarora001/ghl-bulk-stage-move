import { randomUUID } from 'node:crypto';
import {
  clearPreviousJobs,
  hardware,
  http,
  loadDataset,
  prisma,
  sleep,
  startApi,
  startWorker,
  writeResult,
  type JobProgressBody,
  type Service,
} from './common';

/**
 * The benchmark variant of `tests/integration/killResume.test.ts`: same proof, at full scale, with
 * the recovery cost reported as a number.
 *
 * The test answers "is it correct?"; this answers "what does it cost?" — how long from the kill to
 * the job finishing, and how much of that is the restarted process paying for work the dead one
 * had claimed but not committed. At 50 000 items that second figure is the one an operator cares
 * about when deciding whether a rolling restart during a bulk move is safe.
 */

const KILL_AFTER_FRACTION = 0.3;
const POLL_MS = 250;
const TIMEOUT_MS = 15 * 60 * 1000;

async function progressOf(workspaceId: string, jobId: string): Promise<JobProgressBody> {
  const result = await http<JobProgressBody>('GET', `/jobs/${jobId}`, { workspaceId });
  if (result.status !== 200) throw new Error(`progress failed (${result.status})`);
  return result.body;
}

async function waitUntil(
  label: string,
  workspaceId: string,
  jobId: string,
  predicate: (progress: JobProgressBody) => boolean,
  worker: Service,
): Promise<JobProgressBody> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const progress = await progressOf(workspaceId, jobId);
    if (predicate(progress)) return progress;
    if (worker.child.exitCode !== null) {
      throw new Error(`worker exited before ${label}:\n${worker.output.join('')}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const dataset = await loadDataset();
  await clearPreviousJobs(dataset.workspaceId);

  const source = dataset.stages[0]!;
  const target = dataset.stages[dataset.stages.length - 1]!;

  const api = await startApi();
  let first: Service | null = null;
  let second: Service | null = null;
  try {
    const submission = await http<{ jobId: string; totalCount: number }>(
      'POST',
      '/jobs/bulk-move',
      {
        workspaceId: dataset.workspaceId,
        idempotencyKey: `bench-kill-${randomUUID()}`,
        body: { filter: { stageId: source.id }, targetStageId: target.id },
      },
    );
    if (submission.status !== 202) {
      throw new Error(`submission failed (${submission.status}): ${JSON.stringify(submission.body)}`);
    }
    const jobId = submission.body.jobId;
    const itemCount = submission.body.totalCount;
    const killThreshold = Math.floor(itemCount * KILL_AFTER_FRACTION);

    const startedAt = performance.now();
    first = startWorker();
    const atKill = await waitUntil(
      `${killThreshold} items done`,
      dataset.workspaceId,
      jobId,
      (progress) => progress.counts.done >= killThreshold,
      first,
    );

    // SIGKILL, not SIGTERM: the entrypoint handles SIGTERM by draining, which is a clean shutdown,
    // not a crash. The thing under test is the chunk that was mid-transaction when the process
    // stopped existing — the same event a container runtime's kill produces.
    const killedAt = performance.now();
    first.child.kill('SIGKILL');
    await first.exited;
    // Long enough for Postgres to notice the dead connection and roll the open transaction back.
    await sleep(1000);

    const afterKill = await progressOf(dataset.workspaceId, jobId);
    const downtimeStart = performance.now();

    second = startWorker();
    const finished = await waitUntil(
      'the job to drain',
      dataset.workspaceId,
      jobId,
      (progress) => progress.counts.pending === 0,
      second,
    );
    const completedAt = performance.now();
    const finalized = await waitUntil(
      'the job to be finalized',
      dataset.workspaceId,
      jobId,
      (progress) => progress.status !== 'running',
      second,
    );

    // The two proofs, read from committed state rather than inferred from counters.
    const duplicates = await prisma.$queryRaw<{ opportunity_id: string }[]>`
      SELECT opportunity_id FROM transitions WHERE job_id = ${jobId}::uuid
      GROUP BY opportunity_id HAVING count(*) > 1
    `;
    const [applied] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM transitions WHERE job_id = ${jobId}::uuid
    `;
    const appliedCount = Number(applied?.n ?? 0);

    const file = writeResult('kill-resume', {
      name: 'kill-resume',
      generatedAt: new Date().toISOString(),
      hardware: hardware(),
      job: { jobId, itemCount, sourceStage: source.name, targetStage: target.name },
      timeline: {
        toKillMs: Number((killedAt - startedAt).toFixed(0)),
        doneAtKill: atKill.counts.done,
        doneAfterRollback: afterKill.counts.done,
        // Work the dead process had committed to nobody: claimed inside the transaction that died.
        rolledBackItems: Math.max(0, atKill.counts.done - afterKill.counts.done),
        pendingAfterKill: afterKill.counts.pending,
        killToCompletionMs: Number((completedAt - downtimeStart).toFixed(0)),
        totalWallClockMs: Number((completedAt - startedAt).toFixed(0)),
      },
      correctness: {
        duplicateApplies: duplicates.length,
        droppedItems: itemCount - (finished.counts.done + finished.counts.skippedConflict + finished.counts.failed),
        transitionsWritten: appliedCount,
        finalCounts: finished.counts,
        finalStatus: finalized.status,
        finalClassification: finalized.classification,
      },
    });
    process.stdout.write(
      `kill-resume: ${itemCount} items, ${duplicates.length} duplicate applies → ${file}\n`,
    );
  } finally {
    await first?.stop();
    await second?.stop();
    await api.stop();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
