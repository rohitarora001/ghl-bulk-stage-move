import { fingerprint } from '@shared/utils/fingerprint';
import {
  CrossPipelineMoveError,
  FilterStageInvalidError,
  IdempotencyKeyConflictError,
  JobNotFoundError,
  TargetStageInvalidError,
} from '../bulk-move.errors';
import type { BulkMoveRepository } from '../bulk-move.repository';
import { createBulkMoveService } from '../bulk-move.service';
import type { JobProgressCounts } from '../bulk-move.types';

/**
 * The submission and progress rules, without a database.
 *
 * What is being pinned here is the decision — which stage check fails first, when a replay is a
 * 409 rather than a 200, how the four committed counts become one classification — not the SQL
 * that gathers the numbers. The repository is a fake, so each test states exactly the one fact it
 * depends on.
 */

const FILTER = { stageId: 'stage-1' } as never;
const TARGET = 'stage-9';

const submitInput = {
  workspaceId: 'ws-1',
  idempotencyKey: 'key-1',
  filter: FILTER,
  targetStageId: TARGET,
};

const snapshotResult = {
  jobId: 'job-1',
  totalCount: 3,
  matchedCount: 3,
  truncated: false,
  created: true,
};

function repositoryStub(overrides: Partial<BulkMoveRepository> = {}): BulkMoveRepository {
  return {
    // Both stages in the same pipeline unless a test says otherwise.
    findStagePipeline: jest.fn().mockResolvedValue('pipe-1'),
    findJobByIdempotencyKey: jest.fn().mockResolvedValue(null),
    createJobWithSnapshot: jest.fn().mockResolvedValue(snapshotResult),
    findProgress: jest.fn().mockResolvedValue(null),
    retryFailedItems: jest.fn().mockResolvedValue(0),
    isUniqueViolation: jest.fn().mockReturnValue(false),
    ...overrides,
  } as BulkMoveRepository;
}

function counts(overrides: Partial<JobProgressCounts> = {}): JobProgressCounts {
  return {
    id: 'job-1',
    status: 'running',
    totalCount: 10,
    matchedCount: 10,
    truncated: false,
    lastProgressAt: new Date(),
    errorMessage: null,
    done: 5,
    pending: 5,
    skippedConflict: 0,
    failed: 0,
    backedOff: 0,
    stale: false,
    ...overrides,
  };
}

describe('submitBulkMoveJob', () => {
  it('refuses a target stage outside the workspace before writing anything', async () => {
    const repository = repositoryStub({ findStagePipeline: jest.fn().mockResolvedValue(null) });
    const service = createBulkMoveService(repository);

    await expect(service.submitBulkMoveJob(submitInput)).rejects.toBeInstanceOf(
      TargetStageInvalidError,
    );
    expect(repository.createJobWithSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a filter stage outside the workspace', async () => {
    const service = createBulkMoveService(
      repositoryStub({
        findStagePipeline: jest
          .fn()
          .mockResolvedValueOnce('pipe-1') // target resolves
          .mockResolvedValueOnce(null), // filter stage does not
      }),
    );

    await expect(service.submitBulkMoveJob(submitInput)).rejects.toBeInstanceOf(
      FilterStageInvalidError,
    );
  });

  it('refuses a move whose source and target live in different pipelines', async () => {
    const service = createBulkMoveService(
      repositoryStub({
        findStagePipeline: jest
          .fn()
          .mockResolvedValueOnce('pipe-1')
          .mockResolvedValueOnce('pipe-2'),
      }),
    );

    await expect(service.submitBulkMoveJob(submitInput)).rejects.toBeInstanceOf(
      CrossPipelineMoveError,
    );
  });

  it('replays a used key with the original job and never enrols twice', async () => {
    const repository = repositoryStub({
      findJobByIdempotencyKey: jest.fn().mockResolvedValue({
        id: 'job-original',
        totalCount: 7,
        matchedCount: 7,
        truncated: false,
        requestFingerprint: fingerprint({ filter: FILTER, targetStageId: TARGET }),
      }),
    });
    const service = createBulkMoveService(repository);

    const result = await service.submitBulkMoveJob(submitInput);

    expect(result).toMatchObject({ jobId: 'job-original', created: false });
    expect(repository.createJobWithSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a key reused for a different request rather than replaying the wrong job', async () => {
    // The worst available outcome is a 200 carrying the first job's id: the caller believes a
    // second, different bulk move was accepted, and nothing will ever perform it.
    const service = createBulkMoveService(
      repositoryStub({
        findJobByIdempotencyKey: jest.fn().mockResolvedValue({
          id: 'job-original',
          totalCount: 7,
          matchedCount: 7,
          truncated: false,
          requestFingerprint: fingerprint({ filter: FILTER, targetStageId: 'some-other-stage' }),
        }),
      }),
    );

    await expect(service.submitBulkMoveJob(submitInput)).rejects.toBeInstanceOf(
      IdempotencyKeyConflictError,
    );
  });

  it('replays a job stored before fingerprints existed, rather than 409-ing it', async () => {
    const service = createBulkMoveService(
      repositoryStub({
        findJobByIdempotencyKey: jest.fn().mockResolvedValue({
          id: 'job-old',
          totalCount: 1,
          matchedCount: 1,
          truncated: false,
          requestFingerprint: null,
        }),
      }),
    );

    await expect(service.submitBulkMoveJob(submitInput)).resolves.toMatchObject({
      jobId: 'job-old',
      created: false,
    });
  });

  it('answers the loser of a key race with the winner’s job', async () => {
    const existing = jest
      .fn()
      .mockResolvedValueOnce(null) // pre-check: nothing there yet
      .mockResolvedValueOnce({
        id: 'job-winner',
        totalCount: 4,
        matchedCount: 4,
        truncated: false,
        requestFingerprint: fingerprint({ filter: FILTER, targetStageId: TARGET }),
      });
    const service = createBulkMoveService(
      repositoryStub({
        findJobByIdempotencyKey: existing,
        createJobWithSnapshot: jest.fn().mockRejectedValue(new Error('23505')),
        isUniqueViolation: jest.fn().mockReturnValue(true),
      }),
    );

    await expect(service.submitBulkMoveJob(submitInput)).resolves.toMatchObject({
      jobId: 'job-winner',
      created: false,
    });
  });

  it('rethrows a snapshot failure that is not a key collision', async () => {
    const boom = new Error('connection reset');
    const service = createBulkMoveService(
      repositoryStub({ createJobWithSnapshot: jest.fn().mockRejectedValue(boom) }),
    );

    await expect(service.submitBulkMoveJob(submitInput)).rejects.toBe(boom);
  });
});

describe('getJobProgress', () => {
  it('reports another tenant’s job as not found', async () => {
    const service = createBulkMoveService(repositoryStub());

    await expect(service.getJobProgress('ws-1', 'job-1')).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it('calls a job with claimable work and a fresh heartbeat running', async () => {
    const service = createBulkMoveService(
      repositoryStub({ findProgress: jest.fn().mockResolvedValue(counts()) }),
    );

    await expect(service.getJobProgress('ws-1', 'job-1')).resolves.toMatchObject({
      classification: 'running',
      counts: { done: 5, pending: 5, skippedConflict: 0, failed: 0 },
    });
  });

  it('calls it backing_off when every pending item is waiting out its own backoff', async () => {
    // Freshness is deliberately not part of this: when nothing is claimable, no worker can be
    // failing to claim it.
    const service = createBulkMoveService(
      repositoryStub({
        findProgress: jest.fn().mockResolvedValue(counts({ backedOff: 5, stale: true })),
      }),
    );

    await expect(service.getJobProgress('ws-1', 'job-1')).resolves.toMatchObject({
      classification: 'backing_off',
    });
  });

  it('calls it stuck when work is claimable and nothing has touched it', async () => {
    const service = createBulkMoveService(
      repositoryStub({
        findProgress: jest.fn().mockResolvedValue(counts({ backedOff: 2, stale: true })),
      }),
    );

    await expect(service.getJobProgress('ws-1', 'job-1')).resolves.toMatchObject({
      classification: 'stuck',
    });
  });

  it('trusts the job row once it is terminal', async () => {
    const service = createBulkMoveService(
      repositoryStub({
        findProgress: jest
          .fn()
          .mockResolvedValue(counts({ status: 'completed', pending: 0, done: 10 })),
      }),
    );

    await expect(service.getJobProgress('ws-1', 'job-1')).resolves.toMatchObject({
      classification: 'completed',
    });
  });
});

describe('retryFailedItems', () => {
  it('reports a missing job as not found rather than a zero-item retry', async () => {
    const service = createBulkMoveService(
      repositoryStub({ retryFailedItems: jest.fn().mockResolvedValue(null) }),
    );

    await expect(service.retryFailedItems('ws-1', 'job-1')).rejects.toBeInstanceOf(
      JobNotFoundError,
    );
  });

  it('reports how many items it re-enqueued', async () => {
    const service = createBulkMoveService(
      repositoryStub({ retryFailedItems: jest.fn().mockResolvedValue(12) }),
    );

    await expect(service.retryFailedItems('ws-1', 'job-1')).resolves.toEqual({
      jobId: 'job-1',
      retriedCount: 12,
    });
  });
});
