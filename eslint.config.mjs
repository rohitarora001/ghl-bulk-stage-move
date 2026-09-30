import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Layer boundaries are the reason this file exists.
 *
 * The prose rules in REFACTOR_NOTES.md decay the moment nobody checks them, so the ones that can
 * be expressed as an import restriction are expressed here and fail the build instead.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'bench-results/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        process: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
        node: true,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-console': 'error',
      'no-var': 'error',

      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [
            { pattern: '@config{,/**}', group: 'internal', position: 'before' },
            { pattern: '@shared/**', group: 'internal' },
            { pattern: '@modules/**', group: 'internal' },
            { pattern: '@app/**', group: 'internal' },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'never',
        },
      ],
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',

      // Dependencies point inward. Each zone below is a layer that must not reach outward or
      // sideways; the messages say which layer is supposed to own the thing being imported.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/shared',
              from: './src/modules',
              message: 'shared/ is the inner layer: it must not depend on a feature module.',
            },
            {
              target: './src/shared',
              from: './src/app',
              message: 'shared/ must not depend on the composition root.',
            },
            {
              target: './src/modules',
              from: './src/app',
              message: 'A module must not depend on the composition root that wires it.',
            },
            {
              target: './src/config',
              from: './src/modules',
              message: 'config/ is the innermost layer and depends on nothing in the app.',
            },
            {
              target: './src/config',
              from: './src/shared',
              message: 'config/ is the innermost layer and depends on nothing in the app.',
            },
          ],
        },
      ],
    },
  },

  // Services hold business rules and must be unit-testable without a database: no Prisma, no
  // Express. Repositories are the only door to the database, and they are injected, not imported.
  {
    files: ['src/modules/**/*.service.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@prisma/client', message: 'Prisma belongs in the repository layer.' },
            { name: 'express', message: 'A service must not know it is behind HTTP.' },
          ],
          patterns: [
            {
              group: ['**/shared/database/**', '@shared/database/**'],
              message: 'Inject a repository instead of reaching for a client.',
            },
          ],
        },
      ],
    },
  },

  // Controllers translate HTTP to a service call and back. They never talk to the database.
  {
    files: ['src/modules/**/*.controller.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@prisma/client', message: 'Prisma belongs in the repository layer.' }],
          patterns: [
            {
              group: ['**/*.repository', '**/*.repository.ts'],
              message: 'A controller calls a service; the service owns the repository.',
            },
          ],
        },
      ],
    },
  },

  // Repositories are the database layer: SQL and row mapping, no HTTP concepts.
  {
    files: ['src/modules/**/*.repository.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'express', message: 'A repository must not know about HTTP.' }] },
      ],
    },
  },

  // Scripts and tests are operator-facing or throwaway: console output is the point, and test
  // doubles legitimately need loose typing.
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // These two files configure the tools that would otherwise lint them, and must come last: a
  // flat config block only overrides the blocks above it. The ESLint config is ESM importing
  // dev-only packages the TypeScript resolver does not see; the Jest config is CommonJS.
  { files: ['eslint.config.mjs'], rules: { 'import/no-unresolved': 'off' } },
  {
    files: ['**/*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },

  prettier,
);
