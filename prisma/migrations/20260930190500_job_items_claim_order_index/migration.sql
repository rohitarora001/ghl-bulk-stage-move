-- The index the claim query actually needs.
--
-- `job_items_claimable_idx (job_id, next_attempt_at, id)` cannot serve this query's ORDER BY:
-- `next_attempt_at <= now()` is a range predicate, so `id` is unreachable as a sort key behind it.
-- The planner therefore walked `job_items_pkey` and filtered, skipping a prefix of finished rows
-- that grows with every item this job — and every earlier job — has completed. Measured on a
-- 500k-row dataset at CHUNK_SIZE 500: 1 582 buffers / 3.1 ms at 0 done, 91 828 buffers / 15.6 ms
-- at 45 000 done, 91 837 buffers / 19.5 ms with a previous job's rows also present.
--
-- With this index the same claim at 45 000 done is 1 334 buffers / 3.7 ms: flat in the work
-- already finished, which is what "the cursor is job_items.status" is supposed to mean.
--
-- `job_items_claimable_idx` stays. It is the wrong shape for the claim and the right shape for the
-- picker's `EXISTS (... AND next_attempt_at <= now())`, which takes an Index Only Scan on it.
CREATE INDEX job_items_claim_order_idx
  ON job_items (job_id, id)
  WHERE status = 'pending';
