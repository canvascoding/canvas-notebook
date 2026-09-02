import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { Pool } from 'pg';

import {
  createPostgresPool,
  getPostgresSchemaTableName,
  getPostgresSchemaTables,
  quotePostgresIdentifier,
  runPostgresMigrations,
  type PostgresSchemaTable,
} from './postgres';
import { runMigrations } from './migrate';
import { resolveSqlitePath } from './provider';

const COPY_BATCH_SIZE = 250;

type SchemaColumn = {
  name: string;
};

type SchemaForeignKey = {
  reference: () => {
    foreignTable: PostgresSchemaTable;
  };
};

type TableConfig = {
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
};

export type SqliteToPostgresTableResult = {
  table: string;
  sourceRows: number;
  insertedRows: number;
  skipped: boolean;
  reason?: string;
};

export type SqliteToPostgresTableValidation = {
  table: string;
  sourceRows: number;
  targetRows: number;
};

export type SqliteToPostgresMigrationSummary = {
  sqlitePath: string;
  backup: SqliteToPostgresBackup;
  tables: SqliteToPostgresTableResult[];
  sourceUserCount: number;
  targetUserCount: number;
  sourceOrganizationCount: number;
  targetOrganizationCount: number;
  memoryTables: SqliteToPostgresTableValidation[];
  collaborationTables: SqliteToPostgresTableValidation[];
  reindexRequired: boolean;
};

export type SqliteToPostgresBackup = {
  directory: string;
  snapshotPath: string;
  manifestPath: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

export class SqliteToPostgresMigrationError extends Error {
  constructor(
    public readonly code:
      | 'sqlite_missing'
      | 'maintenance_required'
      | 'backup_failed'
      | 'postgres_unavailable'
      | 'source_empty'
      | 'source_normalization_failed'
      | 'target_validation_failed'
      | 'copy_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SqliteToPostgresMigrationError';
  }
}

export type SqliteToPostgresMigrationOptions = {
  sqlitePath?: string;
  backupRoot?: string;
  offlineConfirmed?: boolean;
  pool?: Pool;
  prepareSource?: (sqlite: Database.Database) => void;
  logger?: (message: string) => void;
};

type CollaborationValidationSpec = {
  table: 'file_collaboration_lineages' | 'file_revisions' | 'file_locks' | 'collaboration_documents';
  identityColumn: 'id';
  compareColumns: string[];
};

const COLLABORATION_VALIDATION_SPECS: CollaborationValidationSpec[] = [
  {
    table: 'file_collaboration_lineages',
    identityColumn: 'id',
    compareColumns: ['workspace_id', 'workspace_type', 'path', 'status', 'archived_at', 'trash_entry_id'],
  },
  {
    table: 'file_revisions',
    identityColumn: 'id',
    compareColumns: [
      'lineage_id', 'revision_number', 'workspace_id', 'workspace_type', 'path',
      'content_hash', 'size_bytes', 'base_revision_id', 'created_at',
    ],
  },
  {
    table: 'file_locks',
    identityColumn: 'id',
    compareColumns: [
      'lineage_id', 'workspace_id', 'workspace_type', 'path', 'revision_id',
      'lock_type', 'status', 'expires_at', 'updated_at',
    ],
  },
  {
    table: 'collaboration_documents',
    identityColumn: 'id',
    compareColumns: [
      'lineage_id', 'workspace_id', 'workspace_type', 'path', 'provider',
      'state_version', 'snapshot_revision_id', 'status', 'updated_at',
    ],
  },
];

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function createSqliteMigrationBackup(
  sqlitePath: string,
  backupRoot?: string,
): Promise<SqliteToPostgresBackup & { workingPath: string }> {
  const createdAt = new Date().toISOString();
  const root = backupRoot ?? path.join(path.dirname(sqlitePath), 'migration-backups', 'sqlite-to-postgres');
  const directory = path.join(
    root,
    `${createdAt.replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`,
  );
  const snapshotPath = path.join(directory, 'source.sqlite.db');
  const workingPath = path.join(directory, 'working.sqlite.db');
  const manifestPath = path.join(directory, 'manifest.json');

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const source = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(snapshotPath);
    } finally {
      source.close();
    }

    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const check = snapshot.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (check?.quick_check !== 'ok') {
        throw new Error(`SQLite migration backup quick_check failed: ${check?.quick_check ?? 'unknown'}`);
      }
    } finally {
      snapshot.close();
    }

    const stats = await fs.stat(snapshotPath);
    const sha256 = await sha256File(snapshotPath);
    const manifest = {
      formatVersion: 1,
      purpose: 'sqlite-to-postgres-offline-import',
      createdAt,
      sourcePath: path.resolve(sqlitePath),
      snapshotFile: path.basename(snapshotPath),
      snapshotSha256: sha256,
      snapshotSizeBytes: stats.size,
      rollback: {
        requiresMaintenanceMode: true,
        instructions: [
          'Stop Canvas Notebook and preserve the current database files.',
          'Restore source.sqlite.db to the configured SQLite path.',
          'Set CANVAS_DATABASE_PROVIDER=sqlite and remove DATABASE_URL from the runtime environment.',
          'Start Canvas Notebook and verify health before resuming writes.',
        ],
      },
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await fs.chmod(snapshotPath, 0o400);
    await fs.copyFile(snapshotPath, workingPath);
    await fs.chmod(workingPath, 0o600);

    return {
      directory,
      snapshotPath,
      manifestPath,
      sha256,
      sizeBytes: stats.size,
      createdAt,
      workingPath,
    };
  } catch (error) {
    throw new SqliteToPostgresMigrationError(
      'backup_failed',
      error instanceof Error ? error.message : 'SQLite migration backup failed.',
    );
  }
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

function schemaTableConfig(table: PostgresSchemaTable): TableConfig {
  return getTableConfig(table as never) as TableConfig;
}

function sortedSchemaTables(): PostgresSchemaTable[] {
  const tables = getPostgresSchemaTables();
  const byName = new Map(tables.map((table) => [getPostgresSchemaTableName(table), table]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const output: PostgresSchemaTable[] = [];

  const visit = (table: PostgresSchemaTable) => {
    const name = getPostgresSchemaTableName(table);
    if (visited.has(name)) return;
    if (visiting.has(name)) return;

    visiting.add(name);
    const config = schemaTableConfig(table);
    for (const foreignKey of config.foreignKeys || []) {
      const dependencyName = getPostgresSchemaTableName(foreignKey.reference().foreignTable);
      if (dependencyName === name) continue;
      const dependency = byName.get(dependencyName);
      if (dependency) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    output.push(table);
  };

  for (const table of tables) visit(table);
  return output;
}

export function sqliteToPostgresTablePlan(): string[] {
  return sortedSchemaTables().map(getPostgresSchemaTableName);
}

function sqliteTableNames(sqlite: Database.Database): Set<string> {
  const rows = sqlite.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function sqliteColumns(sqlite: Database.Database, table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function ensureSqliteColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (sqliteColumns(sqlite, table).includes(column)) return;
  sqlite.exec(
    `ALTER TABLE ${quoteSqliteIdentifier(table)} ADD COLUMN ${quoteSqliteIdentifier(column)} ${definition}`,
  );
}

function importedLineageId(workspaceId: string, filePath: string): string {
  const suffix = createHash('sha256').update(`${workspaceId}\0${filePath}`).digest('hex').slice(0, 32);
  return `file-lineage-import-${suffix}`;
}

function normalizeSqliteCollaborationSource(sqlite: Database.Database): void {
  const tables = sqliteTableNames(sqlite);
  if (!tables.has('file_collaboration_lineages') || !tables.has('file_revisions')) return;

  for (const column of ['organization_id', 'customer_id', 'project_id']) {
    ensureSqliteColumn(sqlite, 'file_collaboration_lineages', column, 'TEXT');
  }
  ensureSqliteColumn(sqlite, 'file_revisions', 'revision_number', 'INTEGER');
  if (tables.has('file_locks')) ensureSqliteColumn(sqlite, 'file_locks', 'lineage_id', 'TEXT');
  if (tables.has('collaboration_documents')) {
    ensureSqliteColumn(sqlite, 'collaboration_documents', 'lineage_id', 'TEXT');
  }

  const legacyPaths = sqlite.prepare(`
    SELECT
      workspace_id,
      workspace_type,
      path,
      MAX(organization_id) AS organization_id,
      MAX(customer_id) AS customer_id,
      MAX(project_id) AS project_id,
      MIN(created_at) AS created_at
    FROM file_revisions
    WHERE lineage_id IS NULL
    GROUP BY workspace_id, workspace_type, path
    ORDER BY workspace_id, path
  `).all() as Array<{
    workspace_id: string;
    workspace_type: string;
    path: string;
    organization_id: string | null;
    customer_id: string | null;
    project_id: string | null;
    created_at: number;
  }>;

  const findLineage = sqlite.prepare(`
    SELECT id
    FROM file_collaboration_lineages
    WHERE workspace_id = ? AND path = ?
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, archived_at DESC, created_at DESC, id DESC
    LIMIT 1
  `);
  const insertLineage = sqlite.prepare(`
    INSERT OR IGNORE INTO file_collaboration_lineages (
      id, organization_id, customer_id, project_id, workspace_id, workspace_type,
      path, status, created_at, archived_at, trash_entry_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
  `);
  const assignRevisions = sqlite.prepare(`
    UPDATE file_revisions
    SET lineage_id = ?
    WHERE workspace_id = ? AND path = ? AND lineage_id IS NULL
  `);

  for (const legacyPath of legacyPaths) {
    let lineage = findLineage.get(legacyPath.workspace_id, legacyPath.path) as { id: string } | undefined;
    if (!lineage) {
      const id = importedLineageId(legacyPath.workspace_id, legacyPath.path);
      insertLineage.run(
        id,
        legacyPath.organization_id,
        legacyPath.customer_id,
        legacyPath.project_id,
        legacyPath.workspace_id,
        legacyPath.workspace_type,
        legacyPath.path,
        legacyPath.created_at,
      );
      lineage = { id };
    }
    assignRevisions.run(lineage.id, legacyPath.workspace_id, legacyPath.path);
  }

  for (const table of ['file_locks', 'collaboration_documents'] as const) {
    if (!tables.has(table)) continue;
    sqlite.exec(`
      UPDATE ${quoteSqliteIdentifier(table)}
      SET lineage_id = (
        SELECT lineages.id
        FROM file_collaboration_lineages AS lineages
        WHERE lineages.workspace_id = ${quoteSqliteIdentifier(table)}.workspace_id
          AND lineages.path = ${quoteSqliteIdentifier(table)}.path
        ORDER BY CASE lineages.status WHEN 'active' THEN 0 ELSE 1 END,
          lineages.archived_at DESC, lineages.created_at DESC, lineages.id DESC
        LIMIT 1
      )
      WHERE lineage_id IS NULL
    `);
  }

  sqlite.exec(`
    WITH ranked_revisions AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY lineage_id
          ORDER BY created_at ASC, id ASC
        ) AS next_revision_number
      FROM file_revisions
      WHERE lineage_id IS NOT NULL
    )
    UPDATE file_revisions
    SET revision_number = (
      SELECT next_revision_number
      FROM ranked_revisions
      WHERE ranked_revisions.id = file_revisions.id
    )
    WHERE lineage_id IS NOT NULL;
  `);

  if (tables.has('file_locks')) {
    sqlite.exec(`
      WITH ranked_active_locks AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, path
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS active_rank
        FROM file_locks
        WHERE status = 'active'
      )
      UPDATE file_locks
      SET status = 'expired'
      WHERE id IN (
        SELECT id FROM ranked_active_locks WHERE active_rank > 1
      );
    `);
  }
}

async function postgresColumns(pool: Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

function sqliteRowCount(sqlite: Database.Database, table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(table)}`).get() as { count?: number } | undefined;
  return Number(row?.count || 0);
}

async function postgresRowCount(pool: Pool, table: string): Promise<number> {
  const result = await pool.query<{ count: string | number }>(`SELECT COUNT(*) AS count FROM ${quotePostgresIdentifier(table)}`);
  return Number(result.rows[0]?.count || 0);
}

function sqliteColumnValues(sqlite: Database.Database, table: string, column: string): string[] {
  const rows = sqlite
    .prepare(`SELECT ${quoteSqliteIdentifier(column)} AS value FROM ${quoteSqliteIdentifier(table)}`)
    .all() as Array<{ value: string | number | null }>;
  return rows
    .map((row) => row.value)
    .filter((value): value is string | number => value !== null && value !== undefined)
    .map((value) => String(value));
}

async function missingPostgresValues(pool: Pool, table: string, column: string, values: string[]): Promise<string[]> {
  if (values.length === 0) return [];
  const missing: string[] = [];
  for (let index = 0; index < values.length; index += COPY_BATCH_SIZE) {
    const batch = values.slice(index, index + COPY_BATCH_SIZE);
    const result = await pool.query<{ value: string }>(
      `
        SELECT expected.value
        FROM unnest($1::text[]) AS expected(value)
        LEFT JOIN ${quotePostgresIdentifier(table)} target
          ON target.${quotePostgresIdentifier(column)}::text = expected.value
        WHERE target.${quotePostgresIdentifier(column)} IS NULL
      `,
      [batch],
    );
    missing.push(...result.rows.map((row) => row.value));
  }
  return missing;
}

function comparableValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

async function validateCollaborationTables(params: {
  sqlite: Database.Database;
  pool: Pool;
}): Promise<SqliteToPostgresTableValidation[]> {
  const sourceTables = sqliteTableNames(params.sqlite);
  const validations: SqliteToPostgresTableValidation[] = [];

  for (const spec of COLLABORATION_VALIDATION_SPECS) {
    const sourceRows = sourceTables.has(spec.table) ? sqliteRowCount(params.sqlite, spec.table) : 0;
    const targetRows = await postgresRowCount(params.pool, spec.table);
    validations.push({ table: spec.table, sourceRows, targetRows });
    if (sourceRows === 0) continue;
    if (targetRows < sourceRows) {
      throw new SqliteToPostgresMigrationError(
        'target_validation_failed',
        `Postgres ${spec.table} count ${targetRows} is lower than SQLite count ${sourceRows}.`,
      );
    }

    const selectedColumns = [spec.identityColumn, ...spec.compareColumns];
    const source = params.sqlite.prepare(`
      SELECT ${selectedColumns.map(quoteSqliteIdentifier).join(', ')}
      FROM ${quoteSqliteIdentifier(spec.table)}
      ORDER BY ${quoteSqliteIdentifier(spec.identityColumn)}
    `).all() as Array<Record<string, unknown>>;

    for (let index = 0; index < source.length; index += COPY_BATCH_SIZE) {
      const batch = source.slice(index, index + COPY_BATCH_SIZE);
      const ids = batch.map((row) => String(row[spec.identityColumn]));
      const target = await params.pool.query<Record<string, unknown>>(
        `
          SELECT ${selectedColumns.map(quotePostgresIdentifier).join(', ')}
          FROM ${quotePostgresIdentifier(spec.table)}
          WHERE ${quotePostgresIdentifier(spec.identityColumn)} = ANY($1::text[])
        `,
        [ids],
      );
      const targetById = new Map(
        target.rows.map((row) => [String(row[spec.identityColumn]), row]),
      );
      const missingIds = ids.filter((id) => !targetById.has(id));
      if (missingIds.length > 0) {
        throw new SqliteToPostgresMigrationError(
          'target_validation_failed',
          `Postgres ${spec.table} is missing migrated IDs: ${missingIds.slice(0, 5).join(', ')}`,
        );
      }

      const mismatchedIds = batch.flatMap((sourceRow) => {
        const id = String(sourceRow[spec.identityColumn]);
        const targetRow = targetById.get(id)!;
        const mismatch = spec.compareColumns.some(
          (column) => comparableValue(sourceRow[column]) !== comparableValue(targetRow[column]),
        );
        return mismatch ? [id] : [];
      });
      if (mismatchedIds.length > 0) {
        throw new SqliteToPostgresMigrationError(
          'target_validation_failed',
          `Postgres ${spec.table} has conflicting migrated rows: ${mismatchedIds.slice(0, 5).join(', ')}`,
        );
      }
    }
  }

  return validations;
}

async function insertBatch(
  pool: Pool,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  if (rows.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(row[column]);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const sql = `
    INSERT INTO ${quotePostgresIdentifier(table)} (${columns.map(quotePostgresIdentifier).join(', ')})
    VALUES ${tuples.join(', ')}
    ON CONFLICT DO NOTHING
  `;
  const result = await pool.query(sql, values);
  return result.rowCount ?? 0;
}

async function copyTable(params: {
  sqlite: Database.Database;
  pool: Pool;
  table: string;
  sourceColumns: string[];
  targetColumns: string[];
  sourceRows: number;
  logger?: (message: string) => void;
}): Promise<SqliteToPostgresTableResult> {
  const copyColumns = params.sourceColumns.filter((column) => params.targetColumns.includes(column));
  if (copyColumns.length === 0) {
    return {
      table: params.table,
      sourceRows: params.sourceRows,
      insertedRows: 0,
      skipped: true,
      reason: 'no_common_columns',
    };
  }

  if (params.sourceRows === 0) {
    return {
      table: params.table,
      sourceRows: 0,
      insertedRows: 0,
      skipped: false,
    };
  }

  params.logger?.(`copy ${params.table}: ${params.sourceRows} rows`);
  const select = params.sqlite
    .prepare(`SELECT ${copyColumns.map(quoteSqliteIdentifier).join(', ')} FROM ${quoteSqliteIdentifier(params.table)}`)
    .iterate() as Iterable<Record<string, unknown>>;

  let insertedRows = 0;
  let batch: Array<Record<string, unknown>> = [];
  for (const row of select) {
    batch.push(row);
    if (batch.length >= COPY_BATCH_SIZE) {
      insertedRows += await insertBatch(params.pool, params.table, copyColumns, batch);
      batch = [];
    }
  }
  insertedRows += await insertBatch(params.pool, params.table, copyColumns, batch);

  return {
    table: params.table,
    sourceRows: params.sourceRows,
    insertedRows,
    skipped: false,
  };
}

async function resetSequences(pool: Pool, table: string): Promise<void> {
  const columns = await postgresColumns(pool, table);
  for (const column of columns) {
    const sequenceResult = await pool.query<{ sequence_name: string | null }>(
      'SELECT pg_get_serial_sequence($1, $2) AS sequence_name',
      [`public.${quotePostgresIdentifier(table)}`, column],
    );
    const sequenceName = sequenceResult.rows[0]?.sequence_name;
    if (!sequenceName) continue;

    await pool.query(
      `
        SELECT setval(
          $1::regclass,
          GREATEST(COALESCE((SELECT MAX(${quotePostgresIdentifier(column)}) FROM ${quotePostgresIdentifier(table)}), 0) + 1, 1),
          false
        )
      `,
      [sequenceName],
    );
  }
}

async function validateCoreCounts(params: {
  sqlite: Database.Database;
  pool: Pool;
}): Promise<Pick<
  SqliteToPostgresMigrationSummary,
  | 'sourceUserCount'
  | 'targetUserCount'
  | 'sourceOrganizationCount'
  | 'targetOrganizationCount'
  | 'memoryTables'
  | 'collaborationTables'
>> {
  const sourceTables = sqliteTableNames(params.sqlite);
  const sourceUserCount = sourceTables.has('user') ? sqliteRowCount(params.sqlite, 'user') : 0;
  const sourceOrganizationCount = sourceTables.has('canvas_organization_settings')
    ? sqliteRowCount(params.sqlite, 'canvas_organization_settings')
    : 0;
  const targetUserCount = await postgresRowCount(params.pool, 'user');
  const targetOrganizationCount = await postgresRowCount(params.pool, 'canvas_organization_settings');
  const collaborationTables = await validateCollaborationTables(params);
  const collaborationSourceRows = collaborationTables.reduce(
    (total, table) => total + table.sourceRows,
    0,
  );

  if (sourceUserCount === 0 && collaborationSourceRows === 0) {
    throw new SqliteToPostgresMigrationError(
      'source_empty',
      'SQLite source does not contain auth users or collaboration metadata.',
    );
  }
  if (targetUserCount < sourceUserCount) {
    throw new SqliteToPostgresMigrationError(
      'target_validation_failed',
      `Postgres user count ${targetUserCount} is lower than SQLite user count ${sourceUserCount}.`,
    );
  }
  if (sourceOrganizationCount > 0 && targetOrganizationCount < sourceOrganizationCount) {
    throw new SqliteToPostgresMigrationError(
      'target_validation_failed',
      `Postgres organization count ${targetOrganizationCount} is lower than SQLite organization count ${sourceOrganizationCount}.`,
    );
  }

  const missingUserIds = await missingPostgresValues(params.pool, 'user', 'id', sqliteColumnValues(params.sqlite, 'user', 'id'));
  if (missingUserIds.length > 0) {
    throw new SqliteToPostgresMigrationError(
      'target_validation_failed',
      `Postgres is missing migrated user IDs: ${missingUserIds.slice(0, 5).join(', ')}`,
    );
  }

  if (sourceTables.has('canvas_organization_settings')) {
    const missingOrganizationIds = await missingPostgresValues(
      params.pool,
      'canvas_organization_settings',
      'organization_id',
      sqliteColumnValues(params.sqlite, 'canvas_organization_settings', 'organization_id'),
    );
    if (missingOrganizationIds.length > 0) {
      throw new SqliteToPostgresMigrationError(
        'target_validation_failed',
        `Postgres is missing migrated organization IDs: ${missingOrganizationIds.slice(0, 5).join(', ')}`,
      );
    }
  }

  const memoryTableKeys = [
    ['memory_user_settings', 'user_id'],
    ['memory_collections', 'id'],
    ['memory_entries', 'id'],
    ['memory_events', 'id'],
    ['memory_legacy_imports', 'id'],
    ['memory_review_jobs', 'id'],
  ] as const;
  const memoryTables: SqliteToPostgresTableValidation[] = [];
  for (const [table, identityColumn] of memoryTableKeys) {
    const sourceRows = sourceTables.has(table) ? sqliteRowCount(params.sqlite, table) : 0;
    const targetRows = await postgresRowCount(params.pool, table);
    if (targetRows < sourceRows) {
      throw new SqliteToPostgresMigrationError(
        'target_validation_failed',
        `Postgres ${table} count ${targetRows} is lower than SQLite count ${sourceRows}.`,
      );
    }
    if (sourceRows > 0) {
      const missingIds = await missingPostgresValues(
        params.pool,
        table,
        identityColumn,
        sqliteColumnValues(params.sqlite, table, identityColumn),
      );
      if (missingIds.length > 0) {
        throw new SqliteToPostgresMigrationError(
          'target_validation_failed',
          `Postgres ${table} is missing migrated IDs: ${missingIds.slice(0, 5).join(', ')}`,
        );
      }
    }
    memoryTables.push({ table, sourceRows, targetRows });
  }
  return {
    sourceUserCount,
    targetUserCount,
    sourceOrganizationCount,
    targetOrganizationCount,
    memoryTables,
    collaborationTables,
  };
}

export async function migrateSqliteToPostgres(
  options: SqliteToPostgresMigrationOptions = {},
): Promise<SqliteToPostgresMigrationSummary> {
  const sqlitePath = options.sqlitePath || resolveSqlitePath();
  if (!options.offlineConfirmed) {
    throw new SqliteToPostgresMigrationError(
      'maintenance_required',
      'SQLite-to-Postgres import requires confirmed maintenance mode with application writes stopped.',
    );
  }
  if (!existsSync(sqlitePath)) {
    throw new SqliteToPostgresMigrationError('sqlite_missing', `SQLite database not found: ${sqlitePath}`);
  }

  const backupWithWorkingPath = await createSqliteMigrationBackup(sqlitePath, options.backupRoot);
  const { workingPath, ...backup } = backupWithWorkingPath;
  let sqlite: Database.Database | null = null;
  const ownsPool = !options.pool;
  const pool = options.pool || createPostgresPool();

  try {
    sqlite = new Database(workingPath, { readonly: false, fileMustExist: true });
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 10000');
    try {
      runMigrations(sqlite);
      options.prepareSource?.(sqlite);
      normalizeSqliteCollaborationSource(sqlite);
    } catch (error) {
      throw new SqliteToPostgresMigrationError(
        'source_normalization_failed',
        error instanceof Error ? error.message : 'SQLite migration source normalization failed.',
      );
    }
    await runPostgresMigrations(pool);

    const sourceTables = sqliteTableNames(sqlite);
    const results: SqliteToPostgresTableResult[] = [];

    await pool.query('BEGIN');
    try {
      for (const table of sortedSchemaTables()) {
        const name = getPostgresSchemaTableName(table);
        if (!sourceTables.has(name)) {
          results.push({
            table: name,
            sourceRows: 0,
            insertedRows: 0,
            skipped: true,
            reason: 'source_table_missing',
          });
          continue;
        }

        const sourceColumns = sqliteColumns(sqlite, name);
        const targetColumns = await postgresColumns(pool, name);
        const sourceRows = sqliteRowCount(sqlite, name);
        results.push(await copyTable({
          sqlite,
          pool,
          table: name,
          sourceColumns,
          targetColumns,
          sourceRows,
          logger: options.logger,
        }));
      }

      for (const result of results) {
        if (!result.skipped) await resetSequences(pool, result.table);
      }

      const counts = await validateCoreCounts({ sqlite, pool });
      await pool.query('COMMIT');

      return {
        sqlitePath,
        backup,
        tables: results,
        ...counts,
        reindexRequired: true,
      };
    } catch (error) {
      await pool.query('ROLLBACK');
      if (error instanceof SqliteToPostgresMigrationError) throw error;
      throw new SqliteToPostgresMigrationError(
        'copy_failed',
        error instanceof Error ? error.message : 'SQLite-to-Postgres copy failed.',
      );
    }
  } catch (error) {
    if (error instanceof SqliteToPostgresMigrationError) throw error;
    throw new SqliteToPostgresMigrationError(
      'postgres_unavailable',
      error instanceof Error ? error.message : 'Postgres migration failed.',
    );
  } finally {
    sqlite?.close();
    await fs.rm(workingPath, { force: true });
    if (ownsPool) await pool.end();
  }
}
