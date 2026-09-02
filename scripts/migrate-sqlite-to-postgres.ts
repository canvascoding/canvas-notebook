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
  backupRoot?: string;
  maintenanceConfirmed: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
};

function usage(): string {
  return `Usage:
  canvas-notebook database migrate-sqlite-to-postgres [options]

Options:
  --sqlite-path <path>  Source SQLite database path (default: DATA/sqlite.db)
  --backup-dir <path>   Verified backup root (default: next to the SQLite source)
  --maintenance-confirmed
                       Confirm that application writes and background jobs are stopped
  --json               Print machine-readable JSON
  --verbose            Print per-table copy progress
  -h, --help           Show this help

Creates and verifies an immutable SQLite snapshot, copies a normalized working
copy into Postgres, and leaves the original source unchanged. The command is
idempotent: matching Postgres rows are retained, missing rows are inserted, and
conflicting collaboration rows fail validation instead of being overwritten.`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    verbose: false,
    help: false,
    maintenanceConfirmed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--sqlite-path':
        if (!argv[index + 1]) throw new Error('--sqlite-path requires a value');
        options.sqlitePath = argv[index + 1];
        index += 1;
        break;
      case '--backup-dir':
        if (!argv[index + 1]) throw new Error('--backup-dir requires a value');
        options.backupRoot = argv[index + 1];
        index += 1;
        break;
      case '--maintenance-confirmed':
        options.maintenanceConfirmed = true;
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
      backupRoot: options.backupRoot,
      offlineConfirmed: options.maintenanceConfirmed || process.env.CANVAS_MAINTENANCE_MODE === 'true',
      logger: options.verbose ? log : undefined,
      prepareSource: (sqlite) => sourceBootstrap(sqlite, log),
    });

    if (options.json) {
      printJson({ success: true, ...summary });
    } else {
      const copiedTables = summary.tables.filter((table) => !table.skipped && table.sourceRows > 0);
      const insertedRows = summary.tables.reduce((total, table) => total + table.insertedRows, 0);
      log(`completed: ${copiedTables.length} populated tables, ${insertedRows} inserted rows`);
      log(`verified read-only SQLite backup: ${summary.backup.snapshotPath}`);
      log(`rollback manifest: ${summary.backup.manifestPath}`);
      log(`users: sqlite=${summary.sourceUserCount}, postgres=${summary.targetUserCount}`);
      log(`organizations: sqlite=${summary.sourceOrganizationCount}, postgres=${summary.targetOrganizationCount}`);
      const memoryCounts = new Map(summary.memoryTables.map((table) => [table.table, table]));
      const collections = memoryCounts.get('memory_collections');
      const entries = memoryCounts.get('memory_entries');
      log(`memory collections: sqlite=${collections?.sourceRows ?? 0}, postgres=${collections?.targetRows ?? 0}`);
      log(`memory entries: sqlite=${entries?.sourceRows ?? 0}, postgres=${entries?.targetRows ?? 0}`);
      const collaborationCounts = new Map(summary.collaborationTables.map((table) => [table.table, table]));
      const revisions = collaborationCounts.get('file_revisions');
      const documents = collaborationCounts.get('collaboration_documents');
      log(`file revisions: sqlite=${revisions?.sourceRows ?? 0}, postgres=${revisions?.targetRows ?? 0}`);
      log(`collaboration documents: sqlite=${documents?.sourceRows ?? 0}, postgres=${documents?.targetRows ?? 0}`);
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
