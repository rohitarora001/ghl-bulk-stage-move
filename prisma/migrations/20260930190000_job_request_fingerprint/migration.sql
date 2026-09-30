-- A fingerprint of the request the key was first used for.
--
-- Without it, reusing an Idempotency-Key with a *different* filter or target stage returns the
-- original job with 200 and no indication that the second, different bulk move was never
-- accepted — silently wrong, which is worse than an error. With it, the mismatch is a 409.
--
-- Nullable, because jobs created before this column existed have no fingerprint to compare
-- against and must keep replaying rather than start failing.
ALTER TABLE "jobs" ADD COLUMN "request_fingerprint" TEXT;
