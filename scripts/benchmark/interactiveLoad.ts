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
  summarise,
  writeResult,
  type BenchDataset,
  type JobProgressBody,
  type Service,
} from './common';

/**
 * The isolation claim, measured: does a 50 000-item bulk move make interactive requests slower?
 *
 * Four scenarios, because one number proves nothing. The same workspace as the job and a different
 * workspace, each with and without the job running. The baselines are what make the with-job
 * numbers readable — a p99 of 40ms means nothing until you know the idle p99 was 35ms.
 *
 * The load is open-loop: requests are launched on a fixed schedule and not awaited before the next
 * one goes out. A closed loop (send, wait, send) would throttle itself exactly when the system
 * slows down, which is the moment being measured — it would report a system under less load
 * precisely because it was struggling.
 */

const RATE_PER_SECOND = 20;
const BASELINE_MS = 6_000;
const WITH_JOB_MS = 6_000;

interface Sample {
  kind: 'create' | 'move' | 'list';
  ms: number;
  status: number;
}

interface LoadTarget {
  workspaceId: string;
  pipelineId: string;
  /** Two stages the bulk job never touches, so the load's own moves cannot collide with it. */
  stageA: string;
  stageB: string;
}

/**
 * One request from the interactive mix: list, create, move. Proportions are 2:1:1 because a CRM
 * board reads far more than it writes, and a mix that was mostly writes would measure a workload
 * nobody runs.
 */
async function fire(target: LoadTarget, index: number, pool: string[]): Promise<Sample> {
  const roll = index % 4;
  if (roll < 2) {
    const result = await http<unknown>(
      'GET',
      `/stages/${target.stageA}/opportunities?limit=50`,
      { workspaceId: target.workspaceId },
    );
    return { kind: 'list', ms: result.ms, status: result.status };
  }
  if (roll === 2) {
    const result = await http<{ id?: string }>('POST', '/opportunities', {
      workspaceId: target.workspaceId,
      body: {
        pipelineId: target.pipelineId,
        stageId: target.stageB,
        name: `bench load ${randomUUID()}`,
        value: 1234.56,
        ownerId: randomUUID(),
      },
    });
    if (result.body?.id) pool.push(result.body.id);
    return { kind: 'create', ms: result.ms, status: result.status };
  }
  const id = pool.pop();
  if (!id) {
    // Nothing created yet this run. A list keeps the schedule honest rather than skipping a slot.
    const result = await http<unknown>('GET', `/stages/${target.stageB}/opportunities?limit=50`, {
      workspaceId: target.workspaceId,
    });
    return { kind: 'list', ms: result.ms, status: result.status };
  }
  const result = await http<unknown>('POST', `/opportunities/${id}/move`, {
    workspaceId: target.workspaceId,
    body: { targetStageId: target.stageA },
  });
  return { kind: 'move', ms: result.ms, status: result.status };
}

/**
 * Runs the mix at a fixed rate for `durationMs`, or until `stopWhen` says the thing being measured
 * against has ended. Returns every sample, including failures — a scenario that got faster by
 * erroring out is not a scenario that got faster.
 */
async function runLoad(
  target: LoadTarget,
  durationMs: number,
  stopWhen?: () => Promise<boolean>,
): Promise<{ samples: Sample[]; overlapMs: number }> {
  const spacingMs = 1000 / RATE_PER_SECOND;
  const pool: string[] = [];
  const inFlight: Promise<Sample>[] = [];
  const started = performance.now();
  let index = 0;

  while (performance.now() - started < durationMs) {
    inFlight.push(fire(target, index, pool));
    index += 1;
    if (stopWhen && index % RATE_PER_SECOND === 0 && (await stopWhen())) break;
    const drift = performance.now() - started - index * spacingMs;
    if (drift < 0) await sleep(-drift);
  }
  const overlapMs = Number((performance.now() - started).toFixed(0));
  return { samples: await Promise.all(inFlight), overlapMs };
}

function targetFor(dataset: BenchDataset, which: 'primary' | 'neighbour'): LoadTarget {
  if (which === 'neighbour') {
    return {
      workspaceId: dataset.neighbourWorkspaceId,
      pipelineId: dataset.neighbourPipelineId,
      stageA: dataset.neighbourStages[0]!.id,
      stageB: dataset.neighbourStages[1]!.id,
    };
  }
  // Skips stages[0] (the bulk job's source) and the last (its target): the load must measure
  // contention for database resources, not a lock queue on the same rows.
  return {
    workspaceId: dataset.workspaceId,
    pipelineId: dataset.pipelineId,
    stageA: dataset.stages[1]!.id,
    stageB: dataset.stages[2]!.id,
  };
}

function scenario(label: string, workspace: string, withJob: boolean, samples: Sample[], overlapMs: number) {
  const ok = samples.filter((sample) => sample.status < 400);
  return {
    label,
    workspace,
    bulkJobRunning: withJob,
    durationMs: overlapMs,
    errors: samples.length - ok.length,
    ...summarise(ok.map((sample) => sample.ms)),
    byKind: Object.fromEntries(
      (['list', 'create', 'move'] as const).map((kind) => [
        kind,
        summarise(ok.filter((sample) => sample.kind === kind).map((sample) => sample.ms)),
      ]),
    ),
  };
}

async function main(): Promise<void> {
  const dataset = await loadDataset();
  await clearPreviousJobs(dataset.workspaceId);

  const primary = targetFor(dataset, 'primary');
  const neighbour = targetFor(dataset, 'neighbour');

  const api = await startApi();
  let worker: Service | null = null;
  try {
    // Baselines first, with no worker process in existence at all.
    const primaryBaseline = await runLoad(primary, BASELINE_MS);
    const neighbourBaseline = await runLoad(neighbour, BASELINE_MS);

    const source = dataset.stages[0]!;
    const target = dataset.stages[dataset.stages.length - 1]!;
    const submission = await http<{ jobId: string; totalCount: number }>(
      'POST',
      '/jobs/bulk-move',
      {
        workspaceId: dataset.workspaceId,
        idempotencyKey: `bench-load-${randomUUID()}`,
        body: { filter: { stageId: source.id }, targetStageId: target.id },
      },
    );
    if (submission.status !== 202) {
      throw new Error(`submission failed (${submission.status}): ${JSON.stringify(submission.body)}`);
    }
    const jobId = submission.body.jobId;

    const jobFinished = async (): Promise<boolean> => {
      const progress = await http<JobProgressBody>('GET', `/jobs/${jobId}`, {
        workspaceId: dataset.workspaceId,
      });
      return progress.status === 200 && progress.body.counts.pending === 0;
    };

    worker = startWorker();
    const primaryUnderJob = await runLoad(primary, WITH_JOB_MS, jobFinished);
    const doneAfterPrimary = await http<JobProgressBody>('GET', `/jobs/${jobId}`, {
      workspaceId: dataset.workspaceId,
    });

    // If the job drained during the first window there is nothing left to contend with, so the
    // second window would measure an idle system and quietly report perfect isolation.
    const jobStillRunning = doneAfterPrimary.body.counts.pending > 0;
    const neighbourUnderJob = jobStillRunning
      ? await runLoad(neighbour, WITH_JOB_MS, jobFinished)
      : { samples: [], overlapMs: 0 };

    const scenarios = [
      scenario('baseline', 'same workspace as job', false, primaryBaseline.samples, primaryBaseline.overlapMs),
      scenario('under bulk job', 'same workspace as job', true, primaryUnderJob.samples, primaryUnderJob.overlapMs),
      scenario('baseline', 'different workspace', false, neighbourBaseline.samples, neighbourBaseline.overlapMs),
      scenario('under bulk job', 'different workspace', true, neighbourUnderJob.samples, neighbourUnderJob.overlapMs),
    ];

    const delta = (base: (typeof scenarios)[number], under: (typeof scenarios)[number]) => ({
      workspace: base.workspace,
      p95BaselineMs: base.p95,
      p95UnderJobMs: under.p95,
      p95DeltaMs: Number((under.p95 - base.p95).toFixed(2)),
      p99BaselineMs: base.p99,
      p99UnderJobMs: under.p99,
      p99DeltaMs: Number((under.p99 - base.p99).toFixed(2)),
    });

    const file = writeResult('interactive-load', {
      name: 'interactive-load',
      generatedAt: new Date().toISOString(),
      hardware: hardware(),
      config: {
        ratePerSecond: RATE_PER_SECOND,
        baselineMs: BASELINE_MS,
        withJobMs: WITH_JOB_MS,
        mix: '50% list, 25% create, 25% move',
        openLoop: true,
      },
      job: {
        jobId,
        itemCount: submission.body.totalCount,
        doneAtEndOfPrimaryWindow: doneAfterPrimary.body.counts.done,
        stillRunningAfterPrimaryWindow: jobStillRunning,
      },
      scenarios,
      deltas: [delta(scenarios[0]!, scenarios[1]!), delta(scenarios[2]!, scenarios[3]!)],
    });
    process.stdout.write(`interactive-load: ${scenarios.length} scenarios → ${file}\n`);
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
