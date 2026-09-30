import { loadConfig } from '../../src/shared/config';

const ADMIN = 'postgresql://postgres:postgres@localhost:55433/ghl_test';
const INTERACTIVE =
  'postgresql://app_interactive:app_interactive@localhost:55433/ghl_test?connection_limit=15';
const WORKER = 'postgresql://app_worker:app_worker@localhost:55433/ghl_test?connection_limit=3';

const baseEnv = {
  DATABASE_URL_ADMIN: ADMIN,
  DATABASE_URL_INTERACTIVE: INTERACTIVE,
  DATABASE_URL_WORKER: WORKER,
};

describe('loadConfig', () => {
  it('applies the documented defaults when only the database URLs are set', () => {
    const config = loadConfig(baseEnv);

    expect(config.chunkSize).toBe(500);
    expect(config.bulkMaxItems).toBe(50000);
    expect(config.workerPoolSize).toBe(3);
    expect(config.maxAttempts).toBe(5);
    expect(config.sweepIntervalMs).toBe(2000);
    expect(config.port).toBe(3000);
    expect(config.databaseUrlAdmin).toBe(ADMIN);
    expect(config.databaseUrlInteractive).toBe(INTERACTIVE);
    expect(config.databaseUrlWorker).toBe(WORKER);
  });

  it('names the missing variable when a database URL is absent', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL_ADMIN/);
  });

  it('coerces numeric env vars to numbers rather than leaving them as strings', () => {
    const config = loadConfig({ ...baseEnv, BULK_MAX_ITEMS: '7' });

    expect(config.bulkMaxItems).toBe(7);
    expect(typeof config.bulkMaxItems).toBe('number');
  });

  it('rejects a worker pool size larger than the worker URL connection_limit', () => {
    // Each loop holds one pooled connection for its whole claim+apply transaction, so more
    // loops than connections would wedge the worker at boot rather than fail loudly later.
    expect(() => loadConfig({ ...baseEnv, WORKER_POOL_SIZE: '4' })).toThrow(/connection_limit/);
  });

  it('rejects a worker URL with no connection_limit at all', () => {
    const uncapped = 'postgresql://app_worker:app_worker@localhost:55433/ghl_test';

    expect(() => loadConfig({ ...baseEnv, DATABASE_URL_WORKER: uncapped })).toThrow(
      /connection_limit/,
    );
  });
});
