import { createOpportunitiesController } from '@modules/opportunities/opportunities.controller';
import { createOpportunitiesRepository } from '@modules/opportunities/opportunities.repository';
import { createOpportunitiesService } from '@modules/opportunities/opportunities.service';
import type { OpportunitiesService } from '@modules/opportunities/opportunities.service';
import { interactivePrisma } from '@shared/database';

/**
 * Manual dependency wiring. No container library, no decorators, no reflection.
 *
 * Every module is built the same way — repository over a Prisma client, service over the
 * repository, controller over the service — so "what does this service talk to?" is answered by
 * reading eight lines here instead of by tracing imports through three files.
 *
 * The clients stay lazy `Proxy` wrappers, so importing this module still opens no connection.
 */
export interface Container {
  readonly opportunitiesService: OpportunitiesService;
  readonly opportunitiesController: ReturnType<typeof createOpportunitiesController>;
}

export function createContainer(): Container {
  const opportunitiesRepository = createOpportunitiesRepository(interactivePrisma);
  const opportunitiesService = createOpportunitiesService(opportunitiesRepository);

  return {
    opportunitiesService,
    opportunitiesController: createOpportunitiesController(opportunitiesService),
  };
}

/**
 * The process-wide wiring.
 *
 * One instance per process is what the old module-level singletons already gave us; the
 * difference is that it is now assembled in one visible place and a test can build its own with
 * `createContainer()` or by calling the factories directly.
 */
export const container = createContainer();
