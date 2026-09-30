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
 * The filter fields the brief names: stage, owner, status, value range, date range.
 *
 * `stageId` and `status` are exercised all over the suite because every other test needs a filter
 * to submit with. The other three were not, which is the gap this file closes: the schema accepts
 * them and `filterPredicates()` builds SQL for them, but nothing asserted that filtering by owner,
 * by value, or by date actually selects the right rows.
 *
 * Each test enrols against one field and asserts the *exact* set of enrolled opportunity ids —
 * both that the matching rows are in and that the neighbouring ones are out. Asserting only the
 * count would pass for a predicate that selected the wrong rows in the right quantity.
 */

const app = createApp();

const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';

async function enrolledIds(jobId: string): Promise<string[]> {
  const items = await adminPrisma.jobItem.findMany({
    where: { jobId },
    select: { opportunityId: true },
  });
  return items.map((item) => item.opportunityId).sort();
}

describe('bulk-move filter fields', () => {
  let workspace: WorkspaceFixture;
  let key = 0;

  function submit(filter: Record<string, unknown>) {
    key += 1;
    return request(app)
      .post('/jobs/bulk-move')
      .set('X-Workspace-Id', workspace.workspaceId)
      .set('Idempotency-Key', `filter-key-${key}`)
      .send({ filter, targetStageId: workspace.stageIds[1] });
  }

  beforeEach(async () => {
    await resetDb();
    workspace = await createWorkspace('workspace-a');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('enrols only the named owner’s opportunities', async () => {
    const mine = [
      await createOpportunity(workspace, { ownerId: OWNER_A }),
      await createOpportunity(workspace, { ownerId: OWNER_A }),
    ];
    await createOpportunity(workspace, { ownerId: OWNER_B });

    const response = await submit({ ownerId: OWNER_A });

    expect(response.status).toBe(202);
    expect(response.body.totalCount).toBe(2);
    expect(await enrolledIds(response.body.jobId)).toEqual(mine.map((row) => row.id).sort());
  });

  it('treats valueMin and valueMax as an inclusive range', async () => {
    // The boundaries are the point: `>=` and `<=`, so a row sitting exactly on either edge is in.
    const below = await createOpportunity(workspace, { value: 99.99 });
    const low = await createOpportunity(workspace, { value: 100 });
    const middle = await createOpportunity(workspace, { value: 500 });
    const high = await createOpportunity(workspace, { value: 1000 });
    const above = await createOpportunity(workspace, { value: 1000.01 });

    const response = await submit({ valueMin: 100, valueMax: 1000 });

    expect(response.status).toBe(202);
    const enrolled = await enrolledIds(response.body.jobId);
    expect(enrolled).toEqual([low.id, middle.id, high.id].sort());
    expect(enrolled).not.toContain(below.id);
    expect(enrolled).not.toContain(above.id);
  });

  it('enrols only opportunities created inside the date window', async () => {
    const older = await createOpportunity(workspace, {
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    const inside = await createOpportunity(workspace, {
      createdAt: new Date('2025-06-15T12:00:00.000Z'),
    });
    const newer = await createOpportunity(workspace, {
      createdAt: new Date('2025-12-31T23:59:59.000Z'),
    });

    const response = await submit({
      createdFrom: '2025-06-01T00:00:00.000Z',
      createdTo: '2025-07-01T00:00:00.000Z',
    });

    expect(response.status).toBe(202);
    const enrolled = await enrolledIds(response.body.jobId);
    expect(enrolled).toEqual([inside.id]);
    expect(enrolled).not.toContain(older.id);
    expect(enrolled).not.toContain(newer.id);
  });

  it('applies every filter field together as a conjunction', async () => {
    // The one row that satisfies all five, surrounded by rows that miss on exactly one each.
    const target = await createOpportunity(workspace, {
      stageId: workspace.stageIds[0]!,
      ownerId: OWNER_A,
      status: 'open',
      value: 500,
      createdAt: new Date('2025-06-15T00:00:00.000Z'),
    });
    await createOpportunity(workspace, {
      stageId: workspace.stageIds[2]!, // wrong stage
      ownerId: OWNER_A,
      status: 'open',
      value: 500,
      createdAt: new Date('2025-06-15T00:00:00.000Z'),
    });
    await createOpportunity(workspace, {
      stageId: workspace.stageIds[0]!,
      ownerId: OWNER_B, // wrong owner
      status: 'open',
      value: 500,
      createdAt: new Date('2025-06-15T00:00:00.000Z'),
    });
    await createOpportunity(workspace, {
      stageId: workspace.stageIds[0]!,
      ownerId: OWNER_A,
      status: 'won', // wrong status
      value: 500,
      createdAt: new Date('2025-06-15T00:00:00.000Z'),
    });
    await createOpportunity(workspace, {
      stageId: workspace.stageIds[0]!,
      ownerId: OWNER_A,
      status: 'open',
      value: 5000, // outside the value range
      createdAt: new Date('2025-06-15T00:00:00.000Z'),
    });
    await createOpportunity(workspace, {
      stageId: workspace.stageIds[0]!,
      ownerId: OWNER_A,
      status: 'open',
      value: 500,
      createdAt: new Date('2024-01-01T00:00:00.000Z'), // outside the date window
    });

    const response = await submit({
      stageId: workspace.stageIds[0],
      ownerId: OWNER_A,
      status: 'open',
      valueMin: 100,
      valueMax: 1000,
      createdFrom: '2025-06-01T00:00:00.000Z',
      createdTo: '2025-07-01T00:00:00.000Z',
    });

    expect(response.status).toBe(202);
    expect(response.body.totalCount).toBe(1);
    expect(await enrolledIds(response.body.jobId)).toEqual([target.id]);
  });

  it('accepts a date range written with a UTC offset rather than Z', async () => {
    // 2025-06-15T12:00Z is inside 10:00+05:30 (= 04:30Z) through 20:00+05:30 (= 14:30Z). A
    // comparison done on the raw strings instead of the instants rejects this range as inverted,
    // because '2025-06-15T10:00:00+05:30' sorts after '2025-06-15T20:00:00+05:30' is false but
    // the bound strings compare by character, not by time.
    const inside = await createOpportunity(workspace, {
      createdAt: new Date('2025-06-15T12:00:00.000Z'),
    });

    const response = await submit({
      createdFrom: '2025-06-15T10:00:00+05:30',
      createdTo: '2025-06-15T20:00:00+05:30',
    });

    expect(response.status).toBe(202);
    expect(await enrolledIds(response.body.jobId)).toEqual([inside.id]);
  });

  it('accepts a valid range whose bounds are written in different offsets', async () => {
    // 23:00+05:30 is 17:30Z, which is *before* 18:00Z — a valid one-and-a-half-hour window.
    // Comparing the two strings character by character says '23…' > '18…' and rejects it.
    const inside = await createOpportunity(workspace, {
      createdAt: new Date('2025-06-15T17:45:00.000Z'),
    });

    const response = await submit({
      createdFrom: '2025-06-15T23:00:00+05:30',
      createdTo: '2025-06-15T18:00:00Z',
    });

    expect(response.status).toBe(202);
    expect(await enrolledIds(response.body.jobId)).toEqual([inside.id]);
  });

  it('refuses an inverted range whose bounds are written in different offsets', async () => {
    // 10:00Z is after 11:00+05:30 (= 05:30Z), so this window is inverted and matches nothing.
    // The strings say '10…' < '11…', so a character comparison waves it through.
    const response = await submit({
      createdFrom: '2025-06-15T10:00:00Z',
      createdTo: '2025-06-15T11:00:00+05:30',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_body');
  });

  it('refuses an inverted date range', async () => {
    const response = await submit({
      createdFrom: '2025-07-01T00:00:00.000Z',
      createdTo: '2025-06-01T00:00:00.000Z',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_body');
  });
});
