-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "job_item_status" AS ENUM ('pending', 'done', 'skipped_conflict', 'failed');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "target_stage_id" UUID NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'running',
    "total_count" INTEGER NOT NULL,
    "matched_count" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "last_progress_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_items" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "status" "job_item_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_workspace_id_created_at_idx" ON "jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_workspace_idempotency_uq" ON "jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "job_items_job_id_status_idx" ON "job_items"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_items_job_opportunity_uq" ON "job_items"("job_id", "opportunity_id");

-- AddForeignKey
ALTER TABLE "transitions" ADD CONSTRAINT "transitions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_target_stage_id_fkey" FOREIGN KEY ("target_stage_id") REFERENCES "stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_items" ADD CONSTRAINT "job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added: Prisma's schema language cannot express a partial index.

-- The picker orders running jobs by staleness. Without the `status = 'running'` predicate the
-- index also holds every completed and failed job the instance has ever run, so the scan cost
-- grows with total history rather than with outstanding work.
CREATE INDEX jobs_running_progress_idx
  ON jobs (last_progress_at)
  WHERE status = 'running';

-- The claim query's index. `(job_id, next_attempt_at, id)` matches its ORDER BY exactly, and the
-- `status = 'pending'` predicate keeps finished rows out of it: a job that is 99% done finds its
-- last chunk without walking the 99%, and the index shrinks as the job progresses.
CREATE INDEX job_items_claimable_idx
  ON job_items (job_id, next_attempt_at, id)
  WHERE status = 'pending';
