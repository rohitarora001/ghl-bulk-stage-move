/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 30000,
  // The suite drives one real Postgres; parallel workers would race on TRUNCATE.
  maxWorkers: 1,
  globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
  // Mirrors tsconfig `paths`. Kept in sync by hand: ts-jest reads the compiler options for types,
  // not for module resolution.
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/app/$1',
    '^@config$': '<rootDir>/src/config/index.ts',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
  },
};
