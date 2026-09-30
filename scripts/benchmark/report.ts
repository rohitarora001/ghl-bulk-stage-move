import fs from 'node:fs';
import path from 'node:path';
import { readResult, type Hardware } from './common';

/**
 * Collates the three result files into `BENCHMARKS.md`.
 *
 * Every number in that document comes from a JSON file written by a benchmark run. Nothing is
 * typed in by hand — a hand-edited benchmark table is indistinguishable from a fabricated one, and
 * it silently stops matching the code on the first change that moves the numbers.
 */

interface BulkMoveResult {
  generatedAt: string;
  hardware: Hardware;
  dataset: {
    workspaceId: string;
    totalOpportunities: number;
    sourceStage: { name: string; count: number };
    targetStage: { name: string; count: number };
  };
  submission: {
    stageOnly: {
      latencyMs: number;
      totalCount: number;
      matchedCount: number | null;
      truncated: boolean;
    };
    broad: {
      latencyMs: number;
      totalCount: number;
      matchedCount: number | null;
      truncated: boolean;
    };
  };
  drain: {
    itemCount: number;
    done: number;
    skippedConflict: number;
    failed: number;
    wallClockMs: number;
    itemsPerSecond: number;
    firstThirdItemsPerSecond: number;
    lastThirdItemsPerSecond: number;
    degradationRatio: number;
    buckets: { atSeconds: number; done: number; itemsPerSecond: number }[];
  };
}

interface LoadScenario {
  label: string;
  workspace: string;
  bulkJobRunning: boolean;
  durationMs: number;
  errors: number;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
}

interface InteractiveResult {
  generatedAt: string;
  hardware: Hardware;
  config: { ratePerSecond: number; baselineMs: number; withJobMs: number; mix: string };
  job: {
    itemCount: number;
    doneAtEndOfPrimaryWindow: number;
    stillRunningAfterPrimaryWindow: boolean;
  };
  scenarios: LoadScenario[];
  deltas: {
    workspace: string;
    p95BaselineMs: number;
    p95UnderJobMs: number;
    p95DeltaMs: number;
    p99BaselineMs: number;
    p99UnderJobMs: number;
    p99DeltaMs: number;
  }[];
}

interface KillResumeResult {
  generatedAt: string;
  hardware: Hardware;
  job: { itemCount: number; sourceStage: string; targetStage: string };
  timeline: {
    toKillMs: number;
    doneAtKill: number;
    doneAfterRollback: number;
    rolledBackItems: number;
    pendingAfterKill: number;
    killToCompletionMs: number;
    totalWallClockMs: number;
  };
  correctness: {
    duplicateApplies: number;
    droppedItems: number;
    transitionsWritten: number;
    finalCounts: { done: number; pending: number; skippedConflict: number; failed: number };
    finalStatus: string;
  };
}

/**
 * Digit grouping is pinned to en-US. The default locale follows the machine that ran the
 * benchmark, so the same number would render as 500,000 on one and 5,00,000 on another, and the
 * document would silently disagree with itself across reruns.
 */
const num = (value: number) => value.toLocaleString('en-US');
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
/** `null` means the probe stopped counting at the cap — reporting it as 0 would be a lie. */
const matched = (value: number | null) => (value === null ? 'capped' : num(value));
const missing = (name: string) =>
  `_No \`bench-results/${name}.json\`. Run \`npm run bench:all\` against the large-seeded database._\n`;

function hardwareBlock(hardware: Hardware): string {
  return [
    '## Hardware',
    '',
    '| | |',
    '|---|---|',
    `| CPU | ${hardware.cpuModel} (${hardware.cpuCount} logical cores) |`,
    `| Memory | ${hardware.totalMemGiB} GiB |`,
    `| OS | ${hardware.platform} ${hardware.release} (${hardware.arch}) |`,
    `| Node | ${hardware.nodeVersion} |`,
    `| Postgres | 16 (container) |`,
    '',
  ].join('\n');
}

function bulkSection(result: BulkMoveResult | null): string {
  if (!result) return `## Bulk move\n\n${missing('bulk-move')}`;
  const { submission, drain, dataset } = result;
  const trend =
    drain.degradationRatio >= 0.85
      ? 'steady — the last third sustains the rate of the first'
      : 'degrading — the last third is slower than the first';

  return [
    '## Bulk move',
    '',
    `Dataset: ${num(dataset.totalOpportunities)} opportunities in one workspace; ` +
      `moving from **${dataset.sourceStage.name}** (${num(dataset.sourceStage.count)} rows) ` +
      `to **${dataset.targetStage.name}**.`,
    '',
    '### Submission latency (the synchronous part the caller waits for)',
    '',
    '| Filter shape | Latency | Enrolled | Matched | Truncated |',
    '|---|---:|---:|---:|---|',
    `| Stage only | ${submission.stageOnly.latencyMs} ms | ${num(submission.stageOnly.totalCount)} | ${matched(submission.stageOnly.matchedCount)} | ${submission.stageOnly.truncated} |`,
    `| Broad (\`status\` + \`valueMin\`, no stage or owner) | ${submission.broad.latencyMs} ms | ${num(submission.broad.totalCount)} | ${matched(submission.broad.matchedCount)} | ${submission.broad.truncated} |`,
    '',
    'A `null` match count is the cap doing its job, not a missing measurement: the probe stops ' +
      'counting once it knows the set exceeds `BULK_MAX_ITEMS`, because counting the rest would ' +
      'mean scanning rows the job is never going to touch.',
    '',
    '### Drain',
    '',
    '| | |',
    '|---|---:|',
    `| Items | ${num(drain.itemCount)} |`,
    `| Wall clock | ${seconds(drain.wallClockMs)} |`,
    `| Throughput | ${num(drain.itemsPerSecond)} items/sec |`,
    `| First third | ${num(drain.firstThirdItemsPerSecond)} items/sec |`,
    `| Last third | ${num(drain.lastThirdItemsPerSecond)} items/sec |`,
    `| Applied / skipped on conflict / failed | ${num(drain.done)} / ${drain.skippedConflict} / ${drain.failed} |`,
    '',
    `Throughput is **${trend}** (last third / first third = ${drain.degradationRatio}). ` +
      "That is the shape the design predicts: the claim query filters on `status = 'pending'` " +
      'against a partial index that shrinks as the job drains, so finding the next chunk does not ' +
      'get more expensive as the finished ones pile up.',
    '',
    '<details><summary>Per-poll timeseries</summary>',
    '',
    '| t (s) | done | items/sec |',
    '|---:|---:|---:|',
    ...drain.buckets.map(
      (bucket) => `| ${bucket.atSeconds} | ${num(bucket.done)} | ${num(bucket.itemsPerSecond)} |`,
    ),
    '',
    '</details>',
    '',
  ].join('\n');
}

function loadSection(result: InteractiveResult | null): string {
  if (!result) return `## Interactive latency under load\n\n${missing('interactive-load')}`;
  return [
    '## Interactive latency under load',
    '',
    `Open-loop load at ${result.config.ratePerSecond} req/s (${result.config.mix}), ` +
      `${result.config.baselineMs / 1000}s per baseline window and ${result.config.withJobMs / 1000}s ` +
      `alongside a ${num(result.job.itemCount)}-item bulk move. Requests are launched on a ` +
      'fixed schedule and not awaited before the next goes out — a closed loop would throttle itself ' +
      'exactly when the system slowed down, which is the moment being measured.',
    '',
    '| Workspace | Bulk job | Window | Requests | Errors | p50 | p95 | p99 | max |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
    ...result.scenarios.map(
      (s) =>
        `| ${s.workspace} | ${s.bulkJobRunning ? 'running' : 'idle'} | ${seconds(s.durationMs)} | ` +
        `${s.count} | ${s.errors} | ${s.p50} ms | ${s.p95} ms | ${s.p99} ms | ${s.maxMs} ms |`,
    ),
    '',
    'A window shorter than the configured one is a window that ended when the bulk job drained: ' +
      'the load stops with the thing it was measuring against, rather than carrying on against an ' +
      'idle system and averaging the contention away.',
    '',
    '### Delta from baseline',
    '',
    '| Workspace | p95 idle → under job | p99 idle → under job |',
    '|---|---|---|',
    ...result.deltas.map(
      (d) =>
        `| ${d.workspace} | ${d.p95BaselineMs} → ${d.p95UnderJobMs} ms (${d.p95DeltaMs >= 0 ? '+' : ''}${d.p95DeltaMs}) | ` +
        `${d.p99BaselineMs} → ${d.p99UnderJobMs} ms (${d.p99DeltaMs >= 0 ? '+' : ''}${d.p99DeltaMs}) |`,
    ),
    '',
    "The mechanism behind these numbers is the worker role's `connection_limit=3`, not the " +
      'api/worker process split: separate processes would still hold separate pools. The hard ' +
      'Postgres-side cap is what stops a bulk job from taking connections interactive traffic needs.',
    result.job.stillRunningAfterPrimaryWindow
      ? ''
      : '\n> **Caveat:** the bulk job drained before the second load window opened, so the ' +
        '"different workspace, job running" row measures an idle system and is reported as empty ' +
        'rather than as perfect isolation.',
    '',
  ].join('\n');
}

function killSection(result: KillResumeResult | null): string {
  if (!result) return `## Kill and resume\n\n${missing('kill-resume')}`;
  const { timeline, correctness, job } = result;
  return [
    '## Kill and resume',
    '',
    `A ${num(job.itemCount)}-item job, SIGKILLed after ${num(timeline.doneAtKill)} items, ` +
      'then finished by a fresh process that was told nothing about what the dead one had been doing.',
    '',
    '| | |',
    '|---|---:|',
    `| Time to kill point | ${seconds(timeline.toKillMs)} |`,
    `| Items committed at kill | ${num(timeline.doneAtKill)} |`,
    `| Items still committed after rollback | ${num(timeline.doneAfterRollback)} |`,
    `| Work lost to the rollback | ${num(timeline.rolledBackItems)} items |`,
    `| Kill → completion | ${seconds(timeline.killToCompletionMs)} |`,
    `| Total wall clock | ${seconds(timeline.totalWallClockMs)} |`,
    '',
    '| Correctness | |',
    '|---|---:|',
    `| Opportunities applied twice | **${correctness.duplicateApplies}** |`,
    `| Items dropped | **${correctness.droppedItems}** |`,
    `| Transitions written | ${num(correctness.transitionsWritten)} |`,
    `| Final status | ${correctness.finalStatus} |`,
    '',
    'Work lost to the rollback is bounded by one chunk per loop, because a chunk is claimed and ' +
      'applied in a single transaction. Nothing in between is possible: an item is `pending` or it ' +
      'is finished, and `job_items.status` is the cursor, so the replacement process resumes by ' +
      'doing exactly what it always does.',
    '',
  ].join('\n');
}

function main(): void {
  const bulk = readResult<BulkMoveResult>('bulk-move');
  const load = readResult<InteractiveResult>('interactive-load');
  const kill = readResult<KillResumeResult>('kill-resume');
  const hw = bulk?.hardware ?? load?.hardware ?? kill?.hardware ?? null;
  const generatedAt = bulk?.generatedAt ?? load?.generatedAt ?? kill?.generatedAt ?? null;

  const document = [
    '# Benchmarks',
    '',
    '<!-- Generated by `npm run bench:report` from bench-results/*.json. Do not edit by hand. -->',
    '',
    generatedAt ? `Measured ${generatedAt}.` : '_No results yet._',
    '',
    hw ? hardwareBlock(hw) : '',
    bulkSection(bulk),
    loadSection(load),
    killSection(kill),
    '## Reproducing',
    '',
    '```bash',
    'createdb ghl_dev',
    'DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:55433/ghl_dev npm run migrate',
    'DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:55433/ghl_dev npm run seed -- --large',
    'npm run bench:all',
    '```',
    '',
    'Each benchmark starts the real `api` and `worker` entrypoints as separate processes, measures, ' +
      'and stops them. `bench:report` regenerates this file from the JSON they leave behind.',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(process.cwd(), 'BENCHMARKS.md'), document);
  process.stdout.write('BENCHMARKS.md regenerated\n');
}

if (require.main === module) main();
