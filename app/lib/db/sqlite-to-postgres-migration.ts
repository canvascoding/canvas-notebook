import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

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

export type SqliteToPostgresMigrationSummary = {
  sqlitePath: string;
  tables: SqliteToPostgresTableResult[];
  sourceUserCount: number;
  targetUserCount: number;
  sourceOrganizationCount: number;
  targetOrganizationCount: number;
  reindexRequired: boolean;
};

export class SqliteToPostgresMigrationError extends Error {
  constructor(
    public readonly code:
      | 'sqlite_missing'
      | 'postgres_unavailable'
      | 'source_empty'
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
  pool?: Pool;
  prepareSource?: (sqlite: Database.Database) => void;
  logger?: (message: string) => void;
};

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
  'sourceUserCount' | 'targetUserCount' | 'sourceOrganizationCount' | 'targetOrganizationCount'
>> {
  const sourceTables = sqliteTableNames(params.sqlite);
  const sourceUserCount = sourceTables.has('user') ? sqliteRowCount(params.sqlite, 'user') : 0;
  const sourceOrganizationCount = sourceTables.has('canvas_organization_settings')
    ? sqliteRowCount(params.sqlite, 'canvas_organization_settings')
    : 0;
  const targetUserCount = await postgresRowCount(params.pool, 'user');
  const targetOrganizationCount = await postgresRowCount(params.pool, 'canvas_organization_settings');

  if (sourceUserCount === 0) {
    throw new SqliteToPostgresMigrationError('source_empty', 'SQLite source does not contain any auth users.');
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

  return {
    sourceUserCount,
    targetUserCount,
    sourceOrganizationCount,
    targetOrganizationCount,
  };
}

export async function migrateSqliteToPostgres(
  options: SqliteToPostgresMigrationOptions = {},
): Promise<SqliteToPostgresMigrationSummary> {
  const sqlitePath = options.sqlitePath || resolveSqlitePath();
  if (!existsSync(sqlitePath)) {
    throw new SqliteToPostgresMigrationError('sqlite_missing', `SQLite database not found: ${sqlitePath}`);
  }

  const sqlite = new Database(sqlitePath, { readonly: false });
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');

  const ownsPool = !options.pool;
  const pool = options.pool || createPostgresPool();

  try {
    runMigrations(sqlite);
    options.prepareSource?.(sqlite);
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
    sqlite.close();
    if (ownsPool) await pool.end();
  }
}
