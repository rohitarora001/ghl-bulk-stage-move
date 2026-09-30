import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@app/createApp';
import {
  createOpportunity,
  createWorkspace,
  disconnectTestDb,
  resetDb,
  type WorkspaceFixture,
} from '../setup/testDb';

/**
 * Input the caller controls but the happy path never sends.
 *
 * Every case here produced a 500 before this file existed, which is a lie about whose fault the
 * request was: the client cannot fix a server error, so a serialization bug or an oversized header
 * looks like an outage instead of a bad request. The one exception is the last group, which was
 * worse than a 500 — a second, different bulk move answered with the first job's id and 200, so
 * the caller believed work was accepted that nothing would ever do.
 */

const app = createApp();

describe('request hardening', () => {
  let fixture: WorkspaceFixture;
  let sourceStageId: string;
  let targetStageId: string;

  beforeAll(async () => {
    await resetDb();
    fixture = await createWorkspace('hardening');
    sourceStageId = fixture.stageIds[0]!;
    targetStageId = fixture.stageIds[1]!;
    await createOpportunity(fixture, { stageId: sourceStageId });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  function post(idempotencyKey: string) {
    return request(app)
      .post('/jobs/bulk-move')
      .set('X-Workspace-Id', fixture.workspaceId)
      .set('Idempotency-Key', idempotencyKey);
  }

  describe('a body express itself rejects', () => {
    it('answers unparseable JSON with 400, not 500', async () => {
      const response = await post('malformed')
        .set('Content-Type', 'application/json')
        .send('{"filter":');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_json');
    });

    it('answers a body over the size limit with 413, not 500', async () => {
      const response = await post('too-large')
        .set('Content-Type', 'application/json')
        // Valid JSON, just far past `express.json`'s 1mb cap — the parser rejects it before any
        // route sees it, so only the error handler can classify it.
        .send(JSON.stringify({ filter: {}, targetStageId, padding: 'x'.repeat(1_200_000) }));

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('payload_too_large');
    });
  });

  describe('the Idempotency-Key header', () => {
    it('answers an oversized key with 400, not a btree index-size error', async () => {
      // Incompressible: a repeated character is TOAST-compressed and slips under the 2704-byte
      // btree limit, so a key made of 'k' would pass and prove nothing.
      const key = randomBytes(1400).toString('hex');

      const response = await post(key).send({ filter: { stageId: sourceStageId }, targetStageId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('idempotency_key_invalid');
    });

    it('still requires the header to be present and non-empty', async () => {
      const missing = await request(app)
        .post('/jobs/bulk-move')
        .set('X-Workspace-Id', fixture.workspaceId)
        .send({ filter: { stageId: sourceStageId }, targetStageId });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('idempotency_key_required');

      const empty = await post('').send({ filter: { stageId: sourceStageId }, targetStageId });
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe('idempotency_key_required');
    });
  });

  describe('a key reused for a different request', () => {
    it('replays only when the request matches, and refuses when it does not', async () => {
      const body = { filter: { stageId: sourceStageId, status: 'open' }, targetStageId };

      const first = await post('reuse').send(body);
      expect(first.status).toBe(202);

      // Same key, same request: the whole point of the key.
      const replay = await post('reuse').send(body);
      expect(replay.status).toBe(200);
      expect(replay.body.jobId).toBe(first.body.jobId);

      // Key order must not matter — the fingerprint is of the request, not of its serialization.
      const reordered = await post('reuse').send({
        targetStageId,
        filter: { status: 'open', stageId: sourceStageId },
      });
      expect(reordered.status).toBe(200);
      expect(reordered.body.jobId).toBe(first.body.jobId);

      // Same key, different filter: the caller asked for something else and must be told, not
      // handed the old job's id and left believing the new move was accepted.
      const differentFilter = await post('reuse').send({
        filter: { stageId: sourceStageId, status: 'won' },
        targetStageId,
      });
      expect(differentFilter.status).toBe(409);
      expect(differentFilter.body.error.code).toBe('idempotency_key_conflict');

      // Same key, different target stage.
      const differentTarget = await post('reuse').send({
        filter: { stageId: sourceStageId, status: 'open' },
        targetStageId: fixture.stageIds[2]!,
      });
      expect(differentTarget.status).toBe(409);
      expect(differentTarget.body.error.code).toBe('idempotency_key_conflict');
    });
  });
});
