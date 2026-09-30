import request from 'supertest';
import { createApp } from '@app/createApp';
import {
  adminPrisma,
  createOpportunity,
  disconnectTestDb,
  resetDb,
  seedBaseFixture,
  type BaseFixture,
} from '../setup/testDb';

/**
 * A stage id from another tenant is a 400, not a move.
 *
 * Nothing stops a caller supplying one — ids are uuids and the API has no authentication in
 * scope — so the check has to live in the write path, not in the caller's good manners. Without
 * it, one tenant could park its records inside another tenant's pipeline, where that tenant's own
 * listings would then show them.
 */

const app = createApp();

describe('single move to a stage in another workspace', () => {
  let base: BaseFixture;

  beforeEach(async () => {
    await resetDb();
    base = await seedBaseFixture();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('is a 400 and changes nothing', async () => {
    const opportunity = await createOpportunity(base.a, { stageId: base.a.stageIds[0]! });

    const response = await request(app)
      .post(`/opportunities/${opportunity.id}/move`)
      .set('X-Workspace-Id', base.a.workspaceId)
      .send({ targetStageId: base.b.stageIds[1]! });

    expect(response.status).toBe(400);

    const unchanged = await adminPrisma.opportunity.findUniqueOrThrow({
      where: { id: opportunity.id },
    });
    expect(unchanged.stageId).toBe(base.a.stageIds[0]!);
    expect(unchanged.pipelineId).toBe(base.a.pipelineId);
    expect(unchanged.version).toBe(1);
    expect(await adminPrisma.transition.count()).toBe(0);
  });
});
