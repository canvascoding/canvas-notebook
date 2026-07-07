import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { Pool, types } from 'pg';

import * as schema from './schema';

const TABLE_NAME_SYMBOL = Symbol.for('drizzle:Name');

type PgQueryable = Pick<Pool, 'query'>;

export type PostgresSchemaTable = object & {
  [TABLE_NAME_SYMBOL]?: string;
};

type SchemaColumn = {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  isUnique: boolean;
  uniqueName: string;
  autoIncrement?: boolean;
  hasDefault: boolean;
  default?: unknown;
  table?: PostgresSchemaTable;
};

type SqlChunk = {
  value?: string[];
  name?: string;
  queryChunks?: SqlChunk[];
};

let int8ParserConfigured = false;

function configurePgTypeParsers(): void {
  if (int8ParserConfigured) return;
  types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));
  int8ParserConfigured = true;
}

export function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function getPostgresSchemaTableName(table: PostgresSchemaTable): string {
  const name = table[TABLE_NAME_SYMBOL];
  if (!name) throw new Error('Schema table is missing a Drizzle table name.');
  return String(name);
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeConstraintName(name: string): string {
  return name.slice(0, 63);
}

export function getPostgresSchemaTables(): PostgresSchemaTable[] {
  const seen = new Set<string>();
  const tables: PostgresSchemaTable[] = [];

  for (const value of Object.values(schema)) {
    if (!value || typeof value !== 'object') continue;
    const table = value as unknown as PostgresSchemaTable;
    const name = getPostgresSchemaTableName(table);
    if (seen.has(name)) continue;
    seen.add(name);
    tables.push(table);
  }

  return tables.sort((a, b) => getPostgresSchemaTableName(a).localeCompare(getPostgresSchemaTableName(b)));
}

function columnType(column: SchemaColumn): string {
  if (column.autoIncrement) return 'bigserial';

  switch (column.columnType) {
    case 'SQLiteText':
      return 'text';
    case 'SQLiteReal':
      return 'double precision';
    case 'SQLiteBoolean':
    case 'SQLiteInteger':
    case 'SQLiteTimestamp':
      return 'bigint';
    default:
      if (column.dataType === 'string') return 'text';
      if (column.dataType === 'number' || column.dataType === 'boolean' || column.dataType === 'date') return 'bigint';
      return 'text';
  }
}

function defaultSql(column: SchemaColumn): string | null {
  if (!column.hasDefault || column.default === undefined) return null;
  if (typeof column.default === 'string') return quoteLiteral(column.default);
  if (typeof column.default === 'number') return String(column.default);
  if (typeof column.default === 'boolean') return column.default ? '1' : '0';
  return null;
}

function renderColumnDefinition(column: SchemaColumn, includePrimaryKey: boolean): string {
  const parts = [quotePostgresIdentifier(column.name), columnType(column)];
  const defaultValue = defaultSql(column);

  if (includePrimaryKey && column.primary) {
    parts.push('PRIMARY KEY');
  }
  if (column.notNull && !(includePrimaryKey && column.primary)) {
    parts.push('NOT NULL');
  }
  if (defaultValue) {
    parts.push('DEFAULT', defaultValue);
  }

  return parts.join(' ');
}

function renderSqlFragment(fragment: unknown): string | null {
  if (!fragment || typeof fragment !== 'object') return null;
  const sqlFragment = fragment as SqlChunk;
  if (!Array.isArray(sqlFragment.queryChunks)) return null;

  let rendered = '';
  for (const chunk of sqlFragment.queryChunks) {
    if (Array.isArray(chunk.value)) {
      rendered += chunk.value.join('');
    } else if (chunk.name) {
      rendered += quotePostgresIdentifier(chunk.name);
    } else {
      return null;
    }
  }

  return rendered.trim() || null;
}

function createTableSql(table: PostgresSchemaTable): string {
  const tableName = String(table[TABLE_NAME_SYMBOL]);
  const config = getTableConfig(table as never) as {
    columns: SchemaColumn[];
    primaryKeys: Array<{ getName: () => string; columns: SchemaColumn[] }>;
    checks: Array<{ name: string; value: unknown }>;
  };
  const inlinePrimaryColumns = config.columns.filter((column) => column.primary);
  const includeInlinePrimaryKey = inlinePrimaryColumns.length === 1 && config.primaryKeys.length === 0;
  const definitions = config.columns.map((column) => renderColumnDefinition(column, includeInlinePrimaryKey));

  for (const primaryKey of config.primaryKeys) {
    definitions.push(
      `CONSTRAINT ${quotePostgresIdentifier(normalizeConstraintName(primaryKey.getName()))} PRIMARY KEY (${primaryKey.columns
        .map((column) => quotePostgresIdentifier(column.name))
        .join(', ')})`,
    );
  }

  for (const check of config.checks) {
    const expression = renderSqlFragment(check.value);
    if (!expression) continue;
    definitions.push(`CONSTRAINT ${quotePostgresIdentifier(normalizeConstraintName(check.name))} CHECK (${expression})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quotePostgresIdentifier(tableName)} (\n  ${definitions.join(',\n  ')}\n)`;
}

function createColumnAddSql(table: PostgresSchemaTable, column: SchemaColumn): string {
  const tableName = String(table[TABLE_NAME_SYMBOL]);
  return `ALTER TABLE ${quotePostgresIdentifier(tableName)} ADD COLUMN IF NOT EXISTS ${renderColumnDefinition(column, false)}`;
}

function uniqueColumnIndexSql(table: PostgresSchemaTable, column: SchemaColumn): string | null {
  if (!column.isUnique) return null;
  const tableName = String(table[TABLE_NAME_SYMBOL]);
  return `CREATE UNIQUE INDEX IF NOT EXISTS ${quotePostgresIdentifier(normalizeConstraintName(column.uniqueName))} ON ${quotePostgresIdentifier(tableName)} (${quotePostgresIdentifier(column.name)})`;
}

function indexSql(table: PostgresSchemaTable, index: {
  config: {
    name: string;
    columns: SchemaColumn[];
    unique: boolean;
    where?: unknown;
  };
}): string | null {
  const tableName = String(table[TABLE_NAME_SYMBOL]);
  const columns = index.config.columns.map((column) => quotePostgresIdentifier(column.name)).join(', ');
  if (!columns) return null;
  const where = renderSqlFragment(index.config.where);
  return `CREATE ${index.config.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quotePostgresIdentifier(normalizeConstraintName(index.config.name))} ON ${quotePostgresIdentifier(tableName)} (${columns})${where ? ` WHERE ${where}` : ''}`;
}

function foreignKeySql(table: PostgresSchemaTable, foreignKey: {
  getName: () => string;
  onDelete?: string;
  onUpdate?: string;
  reference: () => {
    columns: SchemaColumn[];
    foreignColumns: SchemaColumn[];
    foreignTable: PostgresSchemaTable;
  };
}): string {
  const tableName = String(table[TABLE_NAME_SYMBOL]);
  const reference = foreignKey.reference();
  const constraintName = normalizeConstraintName(foreignKey.getName());
  const columns = reference.columns.map((column) => quotePostgresIdentifier(column.name)).join(', ');
  const foreignTableName = String(reference.foreignTable[TABLE_NAME_SYMBOL]);
  const foreignColumns = reference.foreignColumns.map((column) => quotePostgresIdentifier(column.name)).join(', ');
  const onDelete = foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete.toUpperCase()}` : '';
  const onUpdate = foreignKey.onUpdate ? ` ON UPDATE ${foreignKey.onUpdate.toUpperCase()}` : '';

  return `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = ${quoteLiteral(constraintName)}
      AND conrelid = to_regclass(${quoteLiteral(quotePostgresIdentifier(tableName))})
  ) THEN
    ALTER TABLE ${quotePostgresIdentifier(tableName)}
      ADD CONSTRAINT ${quotePostgresIdentifier(constraintName)}
      FOREIGN KEY (${columns})
      REFERENCES ${quotePostgresIdentifier(foreignTableName)} (${foreignColumns})${onDelete}${onUpdate};
  END IF;
END $$`;
}

export function createPostgresPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required when CANVAS_DATABASE_PROVIDER=postgres.');
  }

  configurePgTypeParsers();

  return new Pool({
    connectionString,
    max: Number.parseInt(process.env.CANVAS_POSTGRES_POOL_MAX || '10', 10),
    idleTimeoutMillis: Number.parseInt(process.env.CANVAS_POSTGRES_IDLE_TIMEOUT_MS || '30000', 10),
  });
}

export function createPostgresDrizzle(pool: Pool) {
  return drizzle(pool, { schema });
}

export async function runPostgresMigrations(pool: PgQueryable): Promise<void> {
  if (process.env.CANVAS_POSTGRES_VECTOR_ENABLED === 'true') {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  }

  const tables = getPostgresSchemaTables();
  for (const table of tables) {
    await pool.query(createTableSql(table));
  }

  for (const table of tables) {
    const config = getTableConfig(table as never) as {
      columns: SchemaColumn[];
      indexes: Array<Parameters<typeof indexSql>[1]>;
      foreignKeys: Array<Parameters<typeof foreignKeySql>[1]>;
    };

    for (const column of config.columns) {
      await pool.query(createColumnAddSql(table, column));
    }

    for (const column of config.columns) {
      const statement = uniqueColumnIndexSql(table, column);
      if (statement) await pool.query(statement);
    }

    for (const index of config.indexes) {
      const statement = indexSql(table, index);
      if (statement) await pool.query(statement);
    }
  }

  for (const table of tables) {
    const config = getTableConfig(table as never) as {
      foreignKeys: Array<Parameters<typeof foreignKeySql>[1]>;
    };
    for (const foreignKey of config.foreignKeys) {
      await pool.query(foreignKeySql(table, foreignKey));
    }
  }

  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `
      INSERT INTO agents (agent_id, name, type, removable, created_at, updated_at)
      VALUES ('canvas-agent', 'Canvas Agent', 'main', 0, $1, $2)
      ON CONFLICT (agent_id) DO NOTHING
    `,
    [now, now],
  );
}
