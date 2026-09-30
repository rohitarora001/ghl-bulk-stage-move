import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  adminPrisma,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * The claim of resumability, tested against a real operating-system process rather than against
 * `claimAndApplyChunk` called in a loop.
 *
 * `tests/part2/resume.test.ts` already proves the algorithm resumes: it stops calling the chunk
 * function and starts calling it again. What it cannot prove is that a process *killed* mid-chunk
 * leaves the database in the state the algorithm assumes it will find. An in-process test unwinds
 * its transaction through the client library; SIGKILL unwinds nothing — Postgres discovers a dead
 * connection and aborts the transaction itself. Those are different code paths, and the one that
 * runs in production is the second.
 *
 * So: spawn the real entrypoint, let it do a meaningful amount of work, SIGKILL it, and check that
 * committed state is exactly "some items done, the rest pending" with nothing in between. Then
 * start a fresh process and require it to finish the job with no item applied twice.
 */

const TOTAL = 4000;
/** Small enough that 4000 items take ~160 chunks, so the kill lands mid-job, not after it. */
const CHUNK_SIZE = 25;
/** Kill once a fifth of the work is committed: unambiguously "partway", on any machine speed. */
const KILL_AFTER_DONE = TOTAL / 5;

jest.setTimeout(180_000);

const WORKER_ENTRYPOINT = path.join(process.cwd(), 'src', 'worker', 'index.ts');

interface SpawnedWorker {
  child: ChildProcess;
  output: string[];
  exited: Promise<void>;
}

/**
 * The entrypoint, run the way `docker compose` runs it: a standalone process with its
 * configuration in the environment and nothing injected.
 *
 * `-r ts-node/register` rather than the `ts-node` binary, because the binary is a `.cmd` shim on
 * Windows and would need a shell — which puts a second process between us and the one we intend to
 * kill. The shim would die and the worker would keep running.
 */
function spawnWorker(): SpawnedWorker {
  const child = spawn(process.execPath, ['-r', 'ts-node/register', WORKER_ENTRYPOINT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHUNK_SIZE: String(CHUNK_SIZE),
      WORKER_POOL_SIZE: '3',
      SWEEP_INTERVAL_MS: '1000',
      IDLE_BACKOFF_MS: '50',
      PRISMA_LOG: 'silent',
      // Type errors are the typecheck script's job; a full program check would add seconds to
      // every spawn in this test.
      TS_NODE_TRANSPILE_ONLY: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { child, output, exited };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function countItems(jobId: string): Promise<Record<string, number>> {
  const rows = await adminPrisma.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT status::text AS status, count(*) AS n FROM job_items WHERE job_id = ${jobId}::uuid
    GROUP BY status
  `;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
}

/** Polls committed state — the only thing an operator can see — until `predicate` holds. */
async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  worker: SpawnedWorker,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (worker.child.exitCode !== null) {
      throw new Error(
        `worker exited (${worker.child.exitCode}) before ${label}:\n${worker.output.join('')}`,
      );
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}:\n${worker.output.join('')}`);
}

describe('a worker process killed mid-job', () => {
  let fixture: WorkspaceFixture;
  let jobId: string;
  let targetStageId: string;
  const running: ChildProcess[] = [];

  beforeAll(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
    targetStageId = fixture.stageIds[1]!;

    // Set-based: 4000 round trips would cost more than the test they set up.
    await adminPrisma.$executeRaw`
      INSERT INTO opportunities (workspace_id, pipeline_id, stage_id, name, value, owner_id)
      SELECT ${fixture.workspaceId}::uuid, ${fixture.pipelineId}::uuid, ${fixture.stageIds[0]!}::uuid,
             'kill-resume ' || g, 1000, gen_random_uuid()
      FROM generate_series(1, ${TOTAL}) g
    `;
    const job = await adminPrisma.job.create({
      data: {
        workspaceId: fixture.workspaceId,
        idempotencyKey: 'kill-resume',
        filter: {},
        targetStageId,
        totalCount: TOTAL,
        matchedCount: TOTAL,
      },
    });
    jobId = job.id;
    await adminPrisma.$executeRaw`
      INSERT INTO job_items (job_id, opportunity_id, expected_version)
      SELECT ${jobId}::uuid, id, version FROM opportunities
      WHERE workspace_id = ${fixture.workspaceId}::uuid AND stage_id = ${fixture.stageIds[0]!}::uuid
    `;
  });

  afterAll(async () => {
    for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
    await disconnectTestDb();
  });

  it('leaves no item in limbo, and a fresh process finishes the job applying nothing twice', async () => {
    const first = spawnWorker();
    running.push(first.child);

    await waitFor(
      `${KILL_AFTER_DONE} items done`,
      async () => ((await countItems(jobId)).done ?? 0) >= KILL_AFTER_DONE,
      120_000,
      first,
    );

    first.child.kill('SIGKILL');
    await first.exited;
    // Postgres needs a moment to notice the dead connection and roll the open transaction back.
    await sleep(1000);

    const afterKill = await countItems(jobId);
    // Every item is either finished or waiting. There is no third state — a claimed-but-unfinished
    // item would be work no future process knows to redo.
    expect((afterKill.done ?? 0) + (afterKill.pending ?? 0)).toBe(TOTAL);
    expect(afterKill.done).toBeGreaterThanOrEqual(KILL_AFTER_DONE);
    expect(afterKill.pending).toBeGreaterThan(0);
    expect(afterKill.skipped_conflict ?? 0).toBe(0);
    expect(afterKill.failed ?? 0).toBe(0);

    // With the process gone, the job's heartbeat must stop. An operator watching a stalled
    // `last_progress_at` is the signal that something needs restarting; a timestamp that kept
    // moving after the worker died would be a liveness indicator that indicates nothing.
    const frozenAt = (await adminPrisma.job.findUniqueOrThrow({ where: { id: jobId } }))
      .lastProgressAt;
    await sleep(1500);
    const stillFrozen = (await adminPrisma.job.findUniqueOrThrow({ where: { id: jobId } }))
      .lastProgressAt;
    expect(stillFrozen?.getTime()).toBe(frozenAt?.getTime());
    const midway = await countItems(jobId);
    expect(midway.done).toBe(afterKill.done);

    // A fresh process, told nothing about what the dead one had been doing.
    const second = spawnWorker();
    running.push(second.child);

    await waitFor(
      'the job to finish',
      async () => (await countItems(jobId)).pending === undefined,
      120_000,
      second,
    );
    await waitFor(
      'the job to be finalized',
      async () =>
        (await adminPrisma.job.findUniqueOrThrow({ where: { id: jobId } })).status === 'completed',
      30_000,
      second,
    );

    second.child.kill('SIGKILL');
    await second.exited;

    const duplicates = await adminPrisma.$queryRaw<{ opportunity_id: string }[]>`
      SELECT opportunity_id FROM transitions WHERE job_id = ${jobId}::uuid
      GROUP BY opportunity_id HAVING count(*) > 1
    `;
    expect(duplicates).toEqual([]);

    const final = await countItems(jobId);
    expect(final).toEqual({ done: TOTAL });

    const transitions = await adminPrisma.transition.count({ where: { jobId } });
    expect(transitions).toBe(TOTAL);

    const moved = await adminPrisma.opportunity.count({
      where: { workspaceId: fixture.workspaceId, stageId: targetStageId },
    });
    expect(moved).toBe(TOTAL);
  });
});
