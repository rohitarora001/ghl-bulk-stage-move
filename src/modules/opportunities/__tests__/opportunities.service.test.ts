import { encodeCursor } from '@shared/http/pagination';
import { MAX_PAGE_SIZE } from '../opportunities.constants';
import {
  InvalidCursorError,
  InvalidStageError,
  InvalidTargetStageError,
  OpportunityNotFoundError,
  StageNotFoundError,
  VersionConflictError,
} from '../opportunities.errors';
import type { OpportunitiesRepository } from '../opportunities.repository';
import { createOpportunitiesService } from '../opportunities.service';

/**
 * The rules, without a database.
 *
 * These are the tests the pre-refactor service could not have: it reached for a module-level
 * Prisma client, so every assertion about a rule needed a live Postgres and a seeded workspace.
 * The repository is injected now, so a fake is enough — and what is being tested is visibly the
 * decision, not the SQL.
 */

const record = { id: 'opp-1', version: 1 } as never;

function repositoryStub(overrides: Partial<OpportunitiesRepository> = {}): OpportunitiesRepository {
  return {
    findStageInPipeline: jest.fn().mockResolvedValue(true),
    findStageInWorkspace: jest.fn().mockResolvedValue(true),
    create: jest.fn().mockResolvedValue(record),
    listByStage: jest.fn().mockResolvedValue({ items: [], lastCursor: null, hasMore: false }),
    // The fake runs the callback directly: the service's job is to compose the steps, and whether
    // Postgres wrapped them is the repository's business.
    runInTransaction: jest.fn(async (work: (tx: never) => Promise<unknown>) => work(null as never)),
    lockForMove: jest
      .fn()
      .mockResolvedValue({ id: 'opp-1', pipelineId: 'pipe-1', stageId: 'stage-1', version: 1 }),
    stageBelongsToPipeline: jest.fn().mockResolvedValue(true),
    findById: jest.fn().mockResolvedValue(record),
    applyMove: jest.fn().mockResolvedValue(record),
    ...overrides,
  } as OpportunitiesRepository;
}

const moveInput = {
  workspaceId: 'ws-1',
  opportunityId: 'opp-1',
  targetStageId: 'stage-2',
};

describe('createOpportunity', () => {
  it('refuses a stage that is not in the named pipeline', async () => {
    const repository = repositoryStub({ findStageInPipeline: jest.fn().mockResolvedValue(false) });
    const service = createOpportunitiesService(repository);

    await expect(
      service.createOpportunity({
        workspaceId: 'ws-1',
        pipelineId: 'pipe-1',
        stageId: 'stage-1',
        name: 'Acme',
        value: 10,
        ownerId: 'owner-1',
      }),
    ).rejects.toBeInstanceOf(InvalidStageError);

    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('moveOpportunity', () => {
  it('reports a missing row as not found, and never as someone else’s row', async () => {
    const service = createOpportunitiesService(
      repositoryStub({ lockForMove: jest.fn().mockResolvedValue(null) }),
    );

    await expect(service.moveOpportunity(moveInput)).rejects.toBeInstanceOf(
      OpportunityNotFoundError,
    );
  });

  it('refuses a target stage outside the opportunity’s own pipeline', async () => {
    const service = createOpportunitiesService(
      repositoryStub({ stageBelongsToPipeline: jest.fn().mockResolvedValue(false) }),
    );

    await expect(service.moveOpportunity(moveInput)).rejects.toBeInstanceOf(
      InvalidTargetStageError,
    );
  });

  it('reports a stale expectedVersion as a conflict carrying both versions', async () => {
    const service = createOpportunitiesService(repositoryStub());

    await expect(
      service.moveOpportunity({ ...moveInput, expectedVersion: 7 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { expectedVersion: 7, currentVersion: 1 },
    });
    await expect(
      service.moveOpportunity({ ...moveInput, expectedVersion: 7 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('does nothing at all when the record is already in the target stage', async () => {
    // Bumping the version here would turn every running job's frozen expected_version into a
    // conflict over a change that never happened, and write an X -> X audit row.
    const repository = repositoryStub();
    const service = createOpportunitiesService(repository);

    await service.moveOpportunity({ ...moveInput, targetStageId: 'stage-1' });

    expect(repository.applyMove).not.toHaveBeenCalled();
    expect(repository.findById).toHaveBeenCalled();
  });

  it('applies the move with the stage it came from, for the audit row', async () => {
    const repository = repositoryStub();
    const service = createOpportunitiesService(repository);

    await service.moveOpportunity(moveInput);

    expect(repository.applyMove).toHaveBeenCalledWith(null, {
      workspaceId: 'ws-1',
      opportunityId: 'opp-1',
      fromStageId: 'stage-1',
      toStageId: 'stage-2',
    });
  });
});

describe('listStageOpportunities', () => {
  const listInput = { workspaceId: 'ws-1', stageId: 'stage-1' };

  it('refuses a stage from another workspace as not found', async () => {
    const service = createOpportunitiesService(
      repositoryStub({ findStageInWorkspace: jest.fn().mockResolvedValue(false) }),
    );

    await expect(service.listStageOpportunities(listInput)).rejects.toBeInstanceOf(
      StageNotFoundError,
    );
  });

  it('refuses a cursor that does not decode, rather than restarting the walk', async () => {
    const service = createOpportunitiesService(repositoryStub());

    await expect(
      service.listStageOpportunities({ ...listInput, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('refuses a cursor whose timestamp is not a timestamp', async () => {
    const service = createOpportunitiesService(repositoryStub());

    await expect(
      service.listStageOpportunities({
        ...listInput,
        cursor: encodeCursor({ id: 'opp-1', createdAt: 'yesterday' }),
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('caps the page size a caller can ask for', async () => {
    const repository = repositoryStub();
    const service = createOpportunitiesService(repository);

    await service.listStageOpportunities({ ...listInput, limit: 10_000 });

    expect(repository.listByStage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_PAGE_SIZE }),
    );
  });

  it('returns no cursor when the probe row did not come back', async () => {
    const service = createOpportunitiesService(
      repositoryStub({
        listByStage: jest.fn().mockResolvedValue({
          items: [],
          lastCursor: { createdAt: '2026-01-01 00:00:00+00', id: 'opp-9' },
          hasMore: false,
        }),
      }),
    );

    const page = await service.listStageOpportunities(listInput);

    expect(page.nextCursor).toBeNull();
  });
});
