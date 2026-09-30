/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testTimeout: 30000,
  // The suite drives one real Postgres; parallel workers would race on TRUNCATE.
  maxWorkers: 1,
  globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
};
