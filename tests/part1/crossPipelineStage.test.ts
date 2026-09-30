import request from 'supertest';
import { createApp } from '../../src/api/server';
import {
  adminPrisma,
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * A stage in a different pipeline of the SAME workspace passes every tenant check and is still
 * wrong: the row would end up with `pipeline_id` and `stage_id` naming different pipelines, and
 * every listing that trusts one of the two would disagree with the other.
 */

const app = createApp();

describe('single move to a stage in another pipeline of the same workspace', () => {
  let fixture: WorkspaceFixture;
  let otherPipelineStageId: string;

  beforeEach(async () => {
    await resetDb();
    fixture = await createWorkspace('workspace-a');
    const pipeline = await adminPrisma.pipeline.create({
      data: { workspaceId: fixture.workspaceId, name: 'second pipeline' },
    });
    const stage = await adminPrisma.stage.create({
      data: {
        workspaceId: fixture.workspaceId,
        pipelineId: pipeline.id,
        name: 'second pipeline stage',
        position: 0,
      },
    });
    otherPipelineStageId = stage.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('is a 400 and leaves pipeline_id and stage_id consistent', async () => {
    const opportunity = await createOpportunity(fixture, { stageId: fixture.stageIds[0]! });

    const response = await request(app)
      .post(`/opportunities/${opportunity.id}/move`)
      .set('X-Workspace-Id', fixture.workspaceId)
      .send({ targetStageId: otherPipelineStageId });

    expect(response.status).toBe(400);

    const unchanged = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: opportunity.id },
    });
    expect(unchanged.pipelineId).toBe(fixture.pipelineId);
    expect(unchanged.stageId).toBe(fixture.stageIds[0]!);
    expect(unchanged.version).toBe(1);
  });
});
