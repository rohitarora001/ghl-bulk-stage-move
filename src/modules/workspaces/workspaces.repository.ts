import type { PrismaClient } from '@prisma/client';

export interface WorkspacesRepository {
  /** True when the workspace exists. The only question anything asks about a workspace today. */
  exists(workspaceId: string): Promise<boolean>;
}

export function createWorkspacesRepository(prisma: PrismaClient): WorkspacesRepository {
  return {
    async exists(workspaceId) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });
      return workspace !== null;
    },
  };
}
