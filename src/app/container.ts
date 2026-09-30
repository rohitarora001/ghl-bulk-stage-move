import { createBulkMoveController } from '@modules/bulk-move/bulk-move.controller';
import { createBulkMoveRepository } from '@modules/bulk-move/bulk-move.repository';
import { createBulkMoveService } from '@modules/bulk-move/bulk-move.service';
import type { BulkMoveService } from '@modules/bulk-move/bulk-move.service';
import { createOpportunitiesController } from '@modules/opportunities/opportunities.controller';
import { createOpportunitiesRepository } from '@modules/opportunities/opportunities.repository';
import { createOpportunitiesService } from '@modules/opportunities/opportunities.service';
import type { OpportunitiesService } from '@modules/opportunities/opportunities.service';
import { createWorkspacesRepository } from '@modules/workspaces/workspaces.repository';
import type { WorkspacesRepository } from '@modules/workspaces/workspaces.repository';
import { interactivePrisma } from '@shared/database';

/**
 * Manual dependency wiring. No container library, no decorators, no reflection.
 *
 * Every module is built the same way — repository over a Prisma client, service over the
 * repository, controller over the service — so "what does this service talk to?" is answered by
 * reading this file instead of by tracing imports through three others.
 *
 * The clients stay lazy `Proxy` wrappers, so importing this module still opens no connection.
 */
export interface Container {
  readonly opportunitiesService: OpportunitiesService;
  readonly opportunitiesController: ReturnType<typeof createOpportunitiesController>;
  readonly bulkMoveService: BulkMoveService;
  readonly bulkMoveController: ReturnType<typeof createBulkMoveController>;
  readonly workspacesRepository: WorkspacesRepository;
}

export function createContainer(): Container {
  const opportunitiesService = createOpportunitiesService(
    createOpportunitiesRepository(interactivePrisma),
  );
  const bulkMoveService = createBulkMoveService(createBulkMoveRepository(interactivePrisma));

  return {
    opportunitiesService,
    opportunitiesController: createOpportunitiesController(opportunitiesService),
    bulkMoveService,
    bulkMoveController: createBulkMoveController(bulkMoveService),
    workspacesRepository: createWorkspacesRepository(interactivePrisma),
  };
}

/**
 * The process-wide wiring.
 *
 * One instance per process is what the old module-level singletons already gave us; the difference
 * is that it is now assembled in one visible place, and a test can build its own with
 * `createContainer()` or by calling the factories directly.
 */
export const container = createContainer();
