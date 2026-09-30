import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Shared plumbing for the three benchmarks.
 *
 * They all need the same four things — a connection to the benchmark database, a way to start the
 * real `api` and `worker` entrypoints as separate processes, an HTTP helper, and a place to write
 * results — and three copies of that would drift. Everything a benchmark *measures* lives in the
 * benchmark's own file; only the plumbing is here.
 *
 * The benchmark database is NOT the test database. The suite truncates every table between cases,
 * so the 500 000-row dataset lives in `ghl_dev` (see the header of `scripts/seed.ts`).
 */

const HOST = process.env.BENCH_PG_HOST ?? 'localhost';
const PORT = process.env.BENCH_PG_PORT ?? '55433';
const DB = process.env.BENCH_PG_DB ?? 'ghl_dev';

/** The port the benchmark's own API listens on — not 3000, so a dev server can stay up. */
export const API_PORT = Number(process.env.BENCH_API_PORT ?? 3100);
export const API_BASE = `http://127.0.0.1:${API_PORT}`;

export const RESULTS_DIR = path.join(process.cwd(), 'bench-results');

export function applyBenchEnv(): void {
  process.env.DATABASE_URL_ADMIN ??= `postgresql://postgres:postgres@${HOST}:${PORT}/${DB}`;
  process.env.DATABASE_URL_INTERACTIVE ??= `postgresql://app_interactive:app_interactive@${HOST}:${PORT}/${DB}?connection_limit=15`;
  process.env.DATABASE_URL_WORKER ??= `postgresql://app_worker:app_worker@${HOST}:${PORT}/${DB}?connection_limit=3`;
  process.env.PRISMA_LOG ??= 'silent';
}

applyBenchEnv();

export const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_ADMIN } },
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Hardware {
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemGiB: number;
  nodeVersion: string;
}

/** Read from the machine, never typed in: a hand-written hardware block rots on the first rerun. */
export function hardware(): Hardware {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
  };
}

export function writeResult(name: string, data: unknown): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export function readResult<T>(name: string): T | null {
  const file = path.join(RESULTS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/**
 * Nearest-rank percentile over an unsorted sample. No interpolation: with a few hundred samples
 * an interpolated p99 invents a latency no request actually experienced.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return Number(sorted[rank - 1]!.toFixed(2));
}

export interface Service {
  name: string;
  child: ChildProcess;
  output: string[];
  exited: Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Starts a real entrypoint as its own process.
 *
 * `node -r ts-node/register <file>`, not the `ts-node` binary: on Windows that binary is a `.cmd`
 * shim that needs a shell, and the kill/resume benchmark would then kill the shim while the worker
 * carried on. Transpile-only because `npm run typecheck` is where type errors are caught, and a
 * full program check would add seconds to every measured start.
 */
export function startService(
  name: string,
  entrypoint: string,
  env: Record<string, string> = {},
): Service {
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', entrypoint],
    {
      cwd: process.cwd(),
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  return {
    name,
    child,
    output,
    exited,
    async stop(signal: NodeJS.Signals = 'SIGKILL') {
      if (child.exitCode === null) child.kill(signal);
      await exited;
    },
  };
}

export async function startApi(): Promise<Service> {
  const api = startService('api', path.join('src', 'api', 'index.ts'), { PORT: String(API_PORT) });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_BASE}/health`);
      if (response.status < 500) return api;
    } catch {
      // Not listening yet.
    }
    if (api.child.exitCode !== null) {
      throw new Error(`api exited before it listened:\n${api.output.join('')}`);
    }
    await sleep(100);
  }
  throw new Error(`api never listened:\n${api.output.join('')}`);
}

export function startWorker(env: Record<string, string> = {}): Service {
  return startService('worker', path.join('src', 'worker', 'index.ts'), {
    WORKER_POOL_SIZE: process.env.BENCH_WORKER_POOL ?? '3',
    ...env,
  });
}

export interface HttpResult<T> {
  status: number;
  ms: number;
  body: T;
}

export async function http<T>(
  method: string,
  pathname: string,
  options: { workspaceId?: string; idempotencyKey?: string; body?: unknown } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.workspaceId) headers['X-Workspace-Id'] = options.workspaceId;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const started = performance.now();
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => null)) as T;
  return { status: response.status, ms: Number((performance.now() - started).toFixed(2)), body };
}

export interface JobProgressBody {
  id: string;
  status: string;
  totalCount: number;
  matchedCount: number | null;
  truncated: boolean;
  counts: { done: number; pending: number; skippedConflict: number; failed: number };
  classification: string;
}

export interface BenchDataset {
  workspaceId: string;
  pipelineId: string;
  /** Stage ids by descending row count. */
  stages: { id: string; name: string; count: number }[];
  totalOpportunities: number;
  /** A second, small workspace — the neighbour whose latency must not move. */
  neighbourWorkspaceId: string;
  neighbourPipelineId: string;
  neighbourStages: { id: string; name: string; count: number }[];
}

/**
 * Finds the seeded benchmark dataset: the workspace with the most opportunities, and the largest
 * of the others as the neighbour. Discovered rather than configured, so a reseed with different
 * ids needs no edit here.
 */
export async function loadDataset(): Promise<BenchDataset> {
  const workspaces = await prisma.$queryRaw<{ workspace_id: string; n: bigint }[]>`
    SELECT workspace_id, count(*) AS n FROM opportunities GROUP BY workspace_id ORDER BY n DESC
  `;
  if (workspaces.length < 2) {
    throw new Error(
      'benchmark dataset not found — seed it first:\n' +
        '  DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:55433/ghl_dev npm run seed -- --large',
    );
  }

  const stagesOf = async (workspaceId: string) =>
    prisma.$queryRaw<{ id: string; name: string; n: bigint }[]>`
      SELECT s.id, s.name, count(o.id) AS n
      FROM stages s LEFT JOIN opportunities o ON o.stage_id = s.id
      WHERE s.workspace_id = ${workspaceId}::uuid
      GROUP BY s.id, s.name
      ORDER BY count(o.id) DESC
    `;

  const primaryId = workspaces[0]!.workspace_id;
  const neighbourId = workspaces[1]!.workspace_id;
  const [primaryStages, neighbourStages] = await Promise.all([
    stagesOf(primaryId),
    stagesOf(neighbourId),
  ]);
  const pipelineOf = async (workspaceId: string) =>
    (await prisma.pipeline.findFirstOrThrow({ where: { workspaceId } })).id;

  return {
    workspaceId: primaryId,
    pipelineId: await pipelineOf(primaryId),
    stages: primaryStages.map((s) => ({ id: s.id, name: s.name, count: Number(s.n) })),
    totalOpportunities: Number(workspaces[0]!.n),
    neighbourWorkspaceId: neighbourId,
    neighbourPipelineId: await pipelineOf(neighbourId),
    neighbourStages: neighbourStages.map((s) => ({ id: s.id, name: s.name, count: Number(s.n) })),
  };
}

/**
 * Clears jobs from previous benchmark runs.
 *
 * Deleting a job cascades to its `job_items` and to the `transitions` it wrote, so a rerun's
 * duplicate-apply check counts only this run's transitions. Stage membership is deliberately NOT
 * restored: each run picks the current largest stage as its source, so reruns keep working on a
 * dataset the previous run reshaped.
 */
export async function clearPreviousJobs(workspaceId: string): Promise<number> {
  const deleted = await prisma.job.deleteMany({ where: { workspaceId } });
  return deleted.count;
}

export function summarise(samples: number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
} {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    maxMs: samples.length === 0 ? 0 : Number(Math.max(...samples).toFixed(2)),
  };
}
