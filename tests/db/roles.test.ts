import { disconnectAll, interactivePrisma, jobPrisma } from '@shared/database';
import { adminPrisma, disconnectTestDb } from '../setup/testDb';

/** Postgres raises this SQLSTATE when `statement_timeout` cancels a query. */
const QUERY_CANCELED = '57014';

describe('application database roles', () => {
  afterAll(async () => {
    await disconnectAll();
    await disconnectTestDb();
  });

  it('pins statement_timeout on each role server-side, not in the connection string', async () => {
    const rows = await adminPrisma.$queryRaw<{ rolname: string; rolconfig: string[] | null }[]>`
      SELECT rolname, rolconfig FROM pg_roles
      WHERE rolname IN ('app_interactive', 'app_worker')
      ORDER BY rolname
    `;
    const config = new Map(rows.map((r) => [r.rolname, r.rolconfig ?? []]));

    // Role-level ALTER ROLE ... SET applies however the connection is opened, rather than
    // depending on a Prisma-specific URL parameter being honoured the same way across versions.
    expect(config.get('app_interactive')).toContain('statement_timeout=10s');
    expect(config.get('app_worker')).toContain('statement_timeout=30s');
  });

  it('authenticates each Prisma client as its own role', async () => {
    const [interactive] = await interactivePrisma.$queryRaw<{ user: string; timeout: string }[]>`
      SELECT current_user AS "user", current_setting('statement_timeout') AS timeout
    `;
    const [worker] = await jobPrisma.$queryRaw<{ user: string; timeout: string }[]>`
      SELECT current_user AS "user", current_setting('statement_timeout') AS timeout
    `;

    expect(interactive?.user).toBe('app_interactive');
    expect(interactive?.timeout).toBe('10s');
    expect(worker?.user).toBe('app_worker');
    expect(worker?.timeout).toBe('30s');
  });

  it('actually cancels a query that outruns the timeout', async () => {
    // Enforcement is proved once, on the interactive role, because it is the same mechanism for
    // both and its 10s bound costs a third of the worker's 30s in wall clock.
    const started = Date.now();

    await expect(interactivePrisma.$queryRawUnsafe('SELECT pg_sleep(13)')).rejects.toMatchObject({
      meta: expect.objectContaining({ code: QUERY_CANCELED }),
    });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(13_000);
  }, 40_000);

  it('caps each client at the connection_limit its URL declares', async () => {
    const rows = await adminPrisma.$queryRaw<{ usename: string; n: bigint }[]>`
      SELECT usename, count(*) AS n FROM pg_stat_activity
      WHERE usename IN ('app_interactive', 'app_worker')
      GROUP BY usename
    `;
    const byRole = new Map(rows.map((r) => [r.usename, Number(r.n)]));

    // Grouping pg_stat_activity by role is the isolation proof the benchmark scripts reuse: it
    // separates job traffic from interactive traffic without the app remembering to set
    // application_name on every connection.
    expect(byRole.get('app_worker') ?? 0).toBeLessThanOrEqual(3);
    expect(byRole.get('app_interactive') ?? 0).toBeLessThanOrEqual(15);
  });

  it('denies both roles the privileges they should never need', async () => {
    await expect(
      jobPrisma.$executeRawUnsafe('DELETE FROM opportunities WHERE false'),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      interactivePrisma.$executeRawUnsafe('CREATE TABLE should_not_exist (id int)'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('grants both roles the writes the application does need', async () => {
    const workspace = await adminPrisma.workspace.create({ data: { name: 'grants-probe' } });

    await expect(
      interactivePrisma.$queryRawUnsafe('SELECT count(*) FROM opportunities'),
    ).resolves.toBeDefined();
    await expect(
      jobPrisma.$queryRawUnsafe('SELECT count(*) FROM transitions'),
    ).resolves.toBeDefined();

    await adminPrisma.workspace.delete({ where: { id: workspace.id } });
  });
});
