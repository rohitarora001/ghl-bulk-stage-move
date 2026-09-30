import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * A database handle that may or may not already be inside a transaction.
 *
 * Repositories take this rather than a `PrismaClient`, so the same method works standalone and as
 * one step of a larger transaction the service opened. Without it, a repository method usable
 * inside a transaction has to be written twice.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface TransactionOptions {
  /** Milliseconds a transaction may run before Prisma rolls it back. */
  readonly timeout?: number;
  /** Milliseconds to wait for a pooled connection before giving up. */
  readonly maxWait?: number;
}

/**
 * Runs `work` in one transaction. Services own transaction boundaries; repositories join them.
 *
 * The boundary matters more here than in most systems: a bulk chunk claims its rows and applies
 * them in a single transaction precisely so that a process that dies mid-chunk leaves every item
 * back at `pending`, with no partial application to reconcile.
 */
export async function withTransaction<T>(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return prisma.$transaction(work, options);
}
