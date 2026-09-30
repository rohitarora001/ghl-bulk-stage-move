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
} from './common';

/**
 * How long a 50 000-item bulk move takes, and whether throughput holds up or decays.
 *
 * The decay question is the point. A design that re-scans the snapshot to find the next chunk
 * gets slower as the job progresses, and a single wall-clock number hides that completely — the
 * job still finishes, just with the last chunks costing several times the first. So this reports a
 * per-second timeseries alongside the total, and the shape of that series is the evidence for the
 * claim that `job_items.status` as the cursor keeps the claim query's cost flat.
 *
 * Submission is timed separately, and for two filter shapes. Submission does the whole snapshot
 * INSERT ... SELECT synchronously inside the request, so its latency is a function of how much
 * work the filter's predicate makes Postgres do — a stage-only filter rides an index, a broad
 * status+value filter cannot.
 */

const POLL_INTERVAL_MS = 500;
const DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

interface Bucket {
  atSeconds: number;
  done: number;
  itemsPerSecond: number;
}

async function timeSubmission(
  workspaceId: string,
  filter: Record<string, unknown>,
  targetStageId: string,
): Promise<{
  ms: number;
  jobId: string;
  totalCount: number;
  matchedCount: number | null;
  truncated: boolean;
}> {
  const result = await http<{
    jobId: string;
    totalCount: number;
    matchedCount: number | null;
    truncated: boolean;
  }>('POST', '/jobs/bulk-move', {
    workspaceId,
    idempotencyKey: `bench-${randomUUID()}`,
    body: { filter, targetStageId },
  });
  if (result.status !== 202) {
    throw new Error(`submission failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return { ms: result.ms, ...result.body };
}

async function main(): Promise<void> {
  const dataset = await loadDataset();
  await clearPreviousJobs(dataset.workspaceId);

  // Biggest stage as the source (the snapshot will hit the 50 000 cap), smallest as the target, so
  // a rerun never moves rows back into the stage it just drained.
  const source = dataset.stages[0]!;
  const target = dataset.stages[dataset.stages.length - 1]!;

  const api = await startApi();
  let worker: ReturnType<typeof startWorker> | null = null;
  try {
    // Both submissions happen with no worker running, so neither one's latency includes contention
    // from the other's items being drained.
    const stageOnly = await timeSubmission(dataset.workspaceId, { stageId: source.id }, target.id);
    const broad = await timeSubmission(
      dataset.workspaceId,
      { status: 'open', valueMin: 500 },
      target.id,
    );

    // The broad job exists only to have been submitted; leaving it would give the worker a second
    // job to interleave with and make the drain timeseries measure two jobs at once.
    await prisma.job.delete({ where: { id: broad.jobId } });

    const startedAt = performance.now();
    worker = startWorker();

    const buckets: Bucket[] = [];
    let previousDone = 0;
    let previousAt = startedAt;
    let finished: JobProgressBody | null = null;

    while (performance.now() - startedAt < DRAIN_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const progress = await http<JobProgressBody>('GET', `/jobs/${stageOnly.jobId}`, {
        workspaceId: dataset.workspaceId,
      });
      if (progress.status !== 200) throw new Error(`progress failed (${progress.status})`);

      const now = performance.now();
      const done = progress.body.counts.done + progress.body.counts.skippedConflict;
      buckets.push({
        atSeconds: Number(((now - startedAt) / 1000).toFixed(2)),
        done,
        itemsPerSecond: Number((((done - previousDone) * 1000) / (now - previousAt)).toFixed(1)),
      });
      previousDone = done;
      previousAt = now;

      if (progress.body.counts.pending === 0) {
        finished = progress.body;
        break;
      }
      if (worker.child.exitCode !== null) {
        throw new Error(`worker exited early:\n${worker.output.join('')}`);
      }
    }
    const wallClockMs = Number((performance.now() - startedAt).toFixed(0));
    if (!finished) throw new Error('job did not drain within the timeout');

    // Steady vs degrading, decided from the data rather than by eye: the mean rate of the last
    // third against the first third, ignoring the partial bucket at each end.
    const rates = buckets.slice(1, -1).map((bucket) => bucket.itemsPerSecond);
    const third = Math.max(1, Math.floor(rates.length / 3));
    const mean = (values: number[]) =>
      values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
    const firstThird = mean(rates.slice(0, third));
    const lastThird = mean(rates.slice(-third));

    const file = writeResult('bulk-move', {
      name: 'bulk-move',
      generatedAt: new Date().toISOString(),
      hardware: hardware(),
      dataset: {
        workspaceId: dataset.workspaceId,
        totalOpportunities: dataset.totalOpportunities,
        sourceStage: { id: source.id, name: source.name, count: source.count },
        targetStage: { id: target.id, name: target.name, count: target.count },
      },
      submission: {
        stageOnly: {
          latencyMs: stageOnly.ms,
          totalCount: stageOnly.totalCount,
          matchedCount: stageOnly.matchedCount,
          truncated: stageOnly.truncated,
        },
        broad: {
          latencyMs: broad.ms,
          totalCount: broad.totalCount,
          matchedCount: broad.matchedCount,
          truncated: broad.truncated,
        },
      },
      drain: {
        itemCount: finished.totalCount,
        done: finished.counts.done,
        skippedConflict: finished.counts.skippedConflict,
        failed: finished.counts.failed,
        wallClockMs,
        itemsPerSecond: Number(((finished.totalCount * 1000) / wallClockMs).toFixed(1)),
        firstThirdItemsPerSecond: Number(firstThird.toFixed(1)),
        lastThirdItemsPerSecond: Number(lastThird.toFixed(1)),
        degradationRatio: Number((firstThird === 0 ? 0 : lastThird / firstThird).toFixed(2)),
        buckets,
      },
    });
    process.stdout.write(`bulk-move: ${finished.totalCount} items in ${wallClockMs}ms → ${file}\n`);
  } finally {
    await worker?.stop();
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
