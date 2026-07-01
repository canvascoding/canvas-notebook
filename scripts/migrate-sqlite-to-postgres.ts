import { createRequire } from 'node:module';

import type Database from 'better-sqlite3';

import {
  migrateSqliteToPostgres,
  SqliteToPostgresMigrationError,
} from '../app/lib/db/sqlite-to-postgres-migration';
import {
  ensureOrganizationBootstrapForExistingUsers,
  OrganizationBootstrapError,
} from '../app/lib/organization/bootstrap';

const require = createRequire(import.meta.url);
const { loadAppEnv } = require('../server/load-app-env.js') as {
  loadAppEnv: (cwd?: string) => string | null;
};

type CliOptions = {
  sqlitePath?: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
};

function usage(): string {
  return `Usage:
  canvas-notebook database migrate-sqlite-to-postgres [options]

Options:
  --sqlite-path <path>  Source SQLite database path (default: DATA/sqlite.db)
  --json               Print machine-readable JSON
  --verbose            Print per-table copy progress
  -h, --help           Show this help

Copies the current SQLite database into the configured Postgres database. The
command is idempotent: existing Postgres rows are left unchanged, missing rows
are inserted, and serial sequences are repaired after the copy.`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, verbose: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--sqlite-path':
        if (!argv[index + 1]) throw new Error('--sqlite-path requires a value');
        options.sqlitePath = argv[index + 1];
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function sourceBootstrap(sqlite: Database.Database, log: (message: string) => void): void {
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForExistingUsers(sqlite);
    sqlite.exec('COMMIT');
    log(`source organization: ${status.organizationId || 'not configured'}`);
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    if (error instanceof OrganizationBootstrapError && error.code === 'NO_USERS') {
      log('source organization bootstrap skipped: no users');
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  loadAppEnv(process.cwd());
  const log = (message: string) => {
    if (!options.json) process.stdout.write(`[sqlite-to-postgres] ${message}\n`);
  };

  try {
    const summary = await migrateSqliteToPostgres({
      sqlitePath: options.sqlitePath,
      logger: options.verbose ? log : undefined,
      prepareSource: (sqlite) => sourceBootstrap(sqlite, log),
    });

    if (options.json) {
      printJson({ success: true, ...summary });
    } else {
      const copiedTables = summary.tables.filter((table) => !table.skipped && table.sourceRows > 0);
      const insertedRows = summary.tables.reduce((total, table) => total + table.insertedRows, 0);
      log(`completed: ${copiedTables.length} populated tables, ${insertedRows} inserted rows`);
      log(`users: sqlite=${summary.sourceUserCount}, postgres=${summary.targetUserCount}`);
      log(`organizations: sqlite=${summary.sourceOrganizationCount}, postgres=${summary.targetOrganizationCount}`);
      if (summary.reindexRequired) log('knowledge indexes require reindex after Postgres cutover');
    }
  } catch (error) {
    const code = error instanceof SqliteToPostgresMigrationError ? error.code : 'unexpected_error';
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      printJson({ success: false, code, error: message });
    } else {
      process.stderr.write(`[sqlite-to-postgres] ${code}: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
