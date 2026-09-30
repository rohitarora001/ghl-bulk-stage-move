import request from 'supertest';
import { createApp } from '@app/createApp';
import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * Submission is the one request that must do real work synchronously: it captures the guest list.
 * These tests pin the two things that makes safe — the snapshot is a committed set of
 * `job_items`, not a filter to be re-evaluated later, and the target stage is validated against
 * the caller's own workspace and pipeline before any of it happens.
 */

const app = createApp();

function submit(workspaceId: string | null, body: unknown, idempotencyKey = 'key-1') {
  const req = request(app).post('/jobs/bulk-move').set('Idempotency-Key', idempotencyKey);
  if (workspaceId !== null) req.set('X-Workspace-Id', workspaceId);
  return req.send(body as object);
}

/** A second pipeline inside an existing workspace, for the cross-pipeline rule. */
async function addPipeline(fixture: WorkspaceFixture, name: string): Promise<{ stageIds: string[] }> {
  const pipeline = await adminPrisma.pipeline.create({
    data: { workspaceId: fixture.workspaceId, name },
  });
  const stageIds: string[] = [];
  for (let position = 0; position < 2; position += 1) {
    const stage = await adminPrisma.stage.create({
      data: {
        workspaceId: fixture.workspaceId,
        pipelineId: pipeline.id,
        name: `${name} stage ${position}`,
        position,
      },
    });
    stageIds.push(stage.id);
  }
  return { stageIds };
}

describe('POST /jobs/bulk-move', () => {
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    a = await createWorkspace('workspace-a');
    b = await createWorkspace('workspace-b');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('refuses a request with no workspace, or one naming a workspace that does not exist', async () => {
    const body = { filter: { stageId: a.stageIds[0] }, targetStageId: a.stageIds[1] };

    const missing = await submit(null, body);
    expect(missing.status).toBe(400);

    const unknown = await submit('00000000-0000-4000-8000-0000000000ff', body, 'key-2');
    expect(unknown.status).toBe(400);

    // A header that is not even a uuid must be refused the same way, not cast and looked up.
    const malformed = await submit('not-a-uuid', body, 'key-3');
    expect(malformed.status).toBe(400);
  });

  it('snapshots the matching opportunities into job_items at their current versions', async () => {
    const matching = [
      await createOpportunity(a, { stageId: a.stageIds[0]! }),
      await createOpportunity(a, { stageId: a.stageIds[0]! }),
      await createOpportunity(a, { stageId: a.stageIds[0]! }),
    ];
    // Same workspace but a different stage, so the filter must leave it out.
    await createOpportunity(a, { stageId: a.stageIds[2]! });
    // Another tenant's row in the same stage position, which must never be enrolled.
    await createOpportunity(b, { stageId: b.stageIds[0]! });

    const response = await submit(a.workspaceId, {
      filter: { stageId: a.stageIds[0] },
      targetStageId: a.stageIds[1],
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      totalCount: 3,
      matchedCount: 3,
      truncated: false,
    });
    expect(response.body.jobId).toBeTruthy();

    const items = await adminPrisma.jobItem.findMany({
      where: { jobId: response.body.jobId },
      orderBy: { id: 'asc' },
    });
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.status === 'pending')).toBe(true);
    expect(items.every((item) => item.attempts === 0)).toBe(true);

    // expected_version is the whole collision mechanism: it must be each row's version as of
    // submission, not a constant and not whatever the row says at apply time.
    const byOpportunity = new Map(items.map((item) => [item.opportunityId, item.expectedVersion]));
    expect([...byOpportunity.keys()].sort()).toEqual(matching.map((row) => row.id).sort());
    for (const row of matching) {
      expect(byOpportunity.get(row.id)).toBe(row.version);
    }
  });

  it('refuses a target stage belonging to another workspace, creating nothing', async () => {
    await createOpportunity(a, { stageId: a.stageIds[0]! });

    // A stage id leaked or guessed from another tenant: without this check, workspace A could
    // move its own opportunities into workspace B's pipeline — a real cross-tenant violation.
    const response = await submit(a.workspaceId, {
      filter: { stageId: a.stageIds[0] },
      targetStageId: b.stageIds[1],
    });

    expect(response.status).toBe(400);
    expect(await adminPrisma.job.count()).toBe(0);
    expect(await adminPrisma.jobItem.count()).toBe(0);
  });

  it('refuses a target stage in a different pipeline of the same workspace', async () => {
    const other = await addPipeline(a, 'second-pipeline');
    await createOpportunity(a, { stageId: a.stageIds[0]! });

    // The workspace check alone passes here. Moving an opportunity into a stage of a pipeline it
    // does not belong to would leave pipeline_id and stage_id pointing at different pipelines —
    // a state with no meaningful answer to "where is this in the pipeline?".
    const response = await submit(a.workspaceId, {
      filter: { stageId: a.stageIds[0] },
      targetStageId: other.stageIds[1],
    });

    expect(response.status).toBe(400);
    expect(await adminPrisma.job.count()).toBe(0);
    expect(await adminPrisma.jobItem.count()).toBe(0);
  });
});
