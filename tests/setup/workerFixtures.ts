import type { PrismaClient } from '@prisma/client';
import { createBulkMoveWorkerRepository } from '@modules/bulk-move/bulk-move.worker.repository';
import {
  createBulkMoveWorkerService,
  type BulkMoveWorkerService,
} from '@modules/bulk-move/bulk-move.worker.service';

/**
 * The worker's service wired over whichever client a test wants to drive it with.
 *
 * Production builds this over the capped `app_worker` pool; the suite mostly uses the admin client
 * so a test is not competing with its own loops for one of three connections.
 */
export function workerFor(prisma: PrismaClient): BulkMoveWorkerService {
  return createBulkMoveWorkerService(createBulkMoveWorkerRepository(prisma));
}
