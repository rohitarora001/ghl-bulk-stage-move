import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * The project's migration runner: roles, then Prisma's migrations, then grants.
 *
 * Order is load-bearing in both directions. Roles come first because `ALTER ROLE ... SET
 * statement_timeout` must exist before anything connects as those roles. Grants come last, and
 * run on *every* invocation rather than once, because `GRANT ... ON ALL TABLES` only covers the
 * tables that exist when it runs — a migration that adds a table after a one-time grant would
 * leave that table unreachable for app_worker, which surfaces as a permission-denied error deep
 * inside the worker loop rather than at deploy time.
 */

const SQL_DIR = join(__dirname, '..', 'prisma', 'sql');

/** Escapes a value for a single-quoted SQL literal. */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function readRolesSql(): string {
  const interactive = process.env.APP_INTERACTIVE_PASSWORD ?? 'app_interactive';
  const worker = process.env.APP_WORKER_PASSWORD ?? 'app_worker';
  return readFileSync(join(SQL_DIR, '000_roles.sql'), 'utf8')
    .replace(/__INTERACTIVE_PASSWORD__/g, sqlLiteral(interactive))
    .replace(/__WORKER_PASSWORD__/g, sqlLiteral(worker));
}

export async function migrate(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is required to run migrations');

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    // Postgres refuses multiple commands in one prepared statement, so each file is split and
    // sent individually.
    for (const statement of splitStatements(readRolesSql())) {
      await admin.$executeRawUnsafe(statement);
    }
    process.stdout.write('roles: app_interactive, app_worker ready\n');
  } finally {
    await admin.$disconnect();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: adminUrl },
  });

  const grantAdmin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const grants = readFileSync(join(SQL_DIR, '999_grants.sql'), 'utf8');
    for (const statement of splitStatements(grants)) {
      await grantAdmin.$executeRawUnsafe(statement);
    }
    process.stdout.write('grants: applied to app_interactive, app_worker\n');
  } finally {
    await grantAdmin.$disconnect();
  }
}

/**
 * Splits a SQL file into individual statements, dropping comment-only and blank fragments.
 *
 * Splitting naively on `;` would cut the roles file's `DO $$ ... $$` block in half, since a
 * PL/pgSQL body is full of semicolons. Dollar-quoted strings and ordinary single-quoted literals
 * are therefore tracked, and a `;` inside either is not a boundary.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  let inSingleQuote = false;
  let dollarTag: string | null = null;

  while (index < sql.length) {
    const rest = sql.slice(index);

    if (dollarTag !== null) {
      if (rest.startsWith(dollarTag)) {
        current += dollarTag;
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
    } else if (inSingleQuote) {
      if (sql[index] === "'") inSingleQuote = false;
    } else {
      const openTag = /^\$[A-Za-z_]*\$/.exec(rest);
      if (openTag) {
        dollarTag = openTag[0];
        current += dollarTag;
        index += dollarTag.length;
        continue;
      }
      if (sql[index] === "'") {
        inSingleQuote = true;
      } else if (sql.startsWith('--', index)) {
        // Drop the comment through to the end of its line.
        const newline = sql.indexOf('\n', index);
        index = newline === -1 ? sql.length : newline + 1;
        continue;
      } else if (sql[index] === ';') {
        statements.push(current.trim());
        current = '';
        index += 1;
        continue;
      }
    }

    current += sql[index];
    index += 1;
  }

  statements.push(current.trim());
  return statements.filter((statement) => statement.length > 0);
}

if (require.main === module) {
  migrate().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
