import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { Pool, types } from 'pg';

import * as schema from './schema';
import {
  TEAM_SEAT_LEGACY_MIGRATION_KEY,
  TEAM_SEAT_LEGACY_MIGRATION_METADATA,
  TEAM_SEAT_LEGACY_MIGRATION_REASON,
} from './migrate';
import { STUDIO_WORKSPACE_BACKFILL_STATEMENTS } from './studio-workspace-migration';

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

export const TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL = `
DO $team_seat_legacy_backfill$
DECLARE
  migration_now bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('${TEAM_SEAT_LEGACY_MIGRATION_KEY}'));

  IF EXISTS (
    SELECT 1
    FROM canvas_data_migrations
    WHERE migration_key = '${TEAM_SEAT_LEGACY_MIGRATION_KEY}'
  ) OR NOT EXISTS (
    SELECT 1
    FROM canvas_organization_settings
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    WITH legacy_access AS (
      SELECT
        organization.organization_id,
        owner.id AS user_id,
        lower(btrim(owner.email)) AS candidate_email
      FROM canvas_organization_settings organization
      INNER JOIN "user" owner
        ON owner.id = organization.owner_user_id

      UNION ALL

      SELECT
        permission.organization_id,
        member.id AS user_id,
        lower(btrim(member.email)) AS candidate_email
      FROM organization_user_permissions permission
      INNER JOIN canvas_organization_settings organization
        ON organization.organization_id = permission.organization_id
      INNER JOIN "user" member
        ON member.id = permission.user_id
      WHERE permission.user_id != organization.owner_user_id
    )
    SELECT 1
    FROM legacy_access
    WHERE candidate_email = ''
      OR strpos(candidate_email, '@') <= 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate Team Seat membership with an invalid legacy identity.';
  END IF;

  IF EXISTS (
    WITH legacy_access AS (
      SELECT
        organization.organization_id,
        lower(btrim(owner.email)) AS candidate_email
      FROM canvas_organization_settings organization
      INNER JOIN "user" owner
        ON owner.id = organization.owner_user_id

      UNION ALL

      SELECT
        permission.organization_id,
        lower(btrim(member.email)) AS candidate_email
      FROM organization_user_permissions permission
      INNER JOIN canvas_organization_settings organization
        ON organization.organization_id = permission.organization_id
      INNER JOIN "user" member
        ON member.id = permission.user_id
      WHERE permission.user_id != organization.owner_user_id
    )
    SELECT 1
    FROM legacy_access
    GROUP BY organization_id, candidate_email
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate duplicate Team Seat legacy identities.';
  END IF;

  WITH legacy_access AS (
    SELECT
      organization.organization_id,
      owner.id AS user_id,
      lower(btrim(owner.email)) AS candidate_email,
      NULLIF(btrim(owner.name), '') AS display_name,
      'owner' AS role,
      CASE
        WHEN COALESCE(owner.banned, 0) != 0 THEN 'suspended'
        WHEN COALESCE(permission.status, 'active') = 'archived' THEN 'removed'
        WHEN COALESCE(permission.status, 'active') != 'active' THEN 'suspended'
        ELSE 'active'
      END AS status,
      COALESCE(permission.created_at, owner.created_at, organization.created_at) AS adopted_at
    FROM canvas_organization_settings organization
    INNER JOIN "user" owner
      ON owner.id = organization.owner_user_id
    LEFT JOIN organization_user_permissions permission
      ON permission.organization_id = organization.organization_id
     AND permission.user_id = owner.id

    UNION ALL

    SELECT
      permission.organization_id,
      member.id AS user_id,
      lower(btrim(member.email)) AS candidate_email,
      NULLIF(btrim(member.name), '') AS display_name,
      CASE
        WHEN permission.role IN ('owner', 'admin', 'member', 'external') THEN permission.role
        ELSE 'member'
      END AS role,
      CASE
        WHEN COALESCE(member.banned, 0) != 0 THEN 'suspended'
        WHEN permission.status = 'archived' THEN 'removed'
        WHEN permission.status != 'active' THEN 'suspended'
        ELSE 'active'
      END AS status,
      COALESCE(permission.created_at, member.created_at, organization.created_at) AS adopted_at
    FROM organization_user_permissions permission
    INNER JOIN canvas_organization_settings organization
      ON organization.organization_id = permission.organization_id
    INNER JOIN "user" member
      ON member.id = permission.user_id
    WHERE permission.user_id != organization.owner_user_id
  )
  INSERT INTO team_memberships (
    id,
    organization_id,
    candidate_email,
    display_name,
    user_id,
    role,
    status,
    external_invitation_id,
    control_plane_operation_id,
    invited_by_user_id,
    invited_at,
    accepted_at,
    activated_at,
    suspended_at,
    removed_at,
    created_at,
    updated_at
  )
  SELECT
    'team-membership-migration-' || md5(organization_id || ':' || user_id),
    organization_id,
    candidate_email,
    display_name,
    user_id,
    role,
    status,
    NULL,
    NULL,
    NULL,
    adopted_at,
    adopted_at,
    adopted_at,
    CASE WHEN status = 'suspended' THEN migration_now ELSE NULL END,
    CASE WHEN status = 'removed' THEN migration_now ELSE NULL END,
    adopted_at,
    migration_now
  FROM legacy_access
  ON CONFLICT DO NOTHING;

  IF EXISTS (
    WITH legacy_access AS (
      SELECT organization.organization_id, owner.id AS user_id
      FROM canvas_organization_settings organization
      INNER JOIN "user" owner
        ON owner.id = organization.owner_user_id

      UNION ALL

      SELECT permission.organization_id, permission.user_id
      FROM organization_user_permissions permission
      INNER JOIN canvas_organization_settings organization
        ON organization.organization_id = permission.organization_id
      WHERE permission.user_id != organization.owner_user_id
    )
    SELECT 1
    FROM legacy_access
    LEFT JOIN team_memberships membership
      ON membership.organization_id = legacy_access.organization_id
     AND membership.user_id = legacy_access.user_id
    WHERE membership.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Team Seat legacy migration could not adopt every existing organization user.';
  END IF;

  WITH legacy_access AS (
    SELECT organization.organization_id, owner.id AS user_id
    FROM canvas_organization_settings organization
    INNER JOIN "user" owner
      ON owner.id = organization.owner_user_id

    UNION ALL

    SELECT permission.organization_id, permission.user_id
    FROM organization_user_permissions permission
    INNER JOIN canvas_organization_settings organization
      ON organization.organization_id = permission.organization_id
    WHERE permission.user_id != organization.owner_user_id
  )
  INSERT INTO team_membership_transitions (
    id,
    membership_id,
    organization_id,
    from_status,
    to_status,
    actor_user_id,
    source,
    reason,
    external_operation_id,
    membership_revision,
    metadata_json,
    created_at
  )
  SELECT
    'team-membership-transition-migration-' || md5(membership.id),
    membership.id,
    membership.organization_id,
    NULL,
    membership.status,
    NULL,
    'migration',
    '${TEAM_SEAT_LEGACY_MIGRATION_REASON}',
    NULL,
    NULL,
    '${TEAM_SEAT_LEGACY_MIGRATION_METADATA}',
    migration_now
  FROM legacy_access
  INNER JOIN team_memberships membership
    ON membership.organization_id = legacy_access.organization_id
   AND membership.user_id = legacy_access.user_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM team_membership_transitions transition
    WHERE transition.membership_id = membership.id
      AND transition.source = 'migration'
      AND transition.metadata_json = '${TEAM_SEAT_LEGACY_MIGRATION_METADATA}'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO team_membership_sync_state (
    organization_id,
    current_revision,
    current_observed_quantity,
    acknowledged_revision,
    created_at,
    updated_at
  )
  SELECT
    organization.organization_id,
    0,
    (
      SELECT COUNT(*)
      FROM team_memberships membership
      WHERE membership.organization_id = organization.organization_id
        AND membership.status = 'active'
        AND membership.user_id IS NOT NULL
        AND membership.accepted_at IS NOT NULL
    ),
    0,
    migration_now,
    migration_now
  FROM canvas_organization_settings organization
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO canvas_data_migrations (
    migration_key,
    completed_at,
    metadata_json
  ) VALUES (
    '${TEAM_SEAT_LEGACY_MIGRATION_KEY}',
    migration_now,
    '{"source":"organization_user_permissions","billableOperationsCreated":0}'
  )
  ON CONFLICT (migration_key) DO NOTHING;
END
$team_seat_legacy_backfill$;
`;

export async function runPostgresTeamSeatLegacyBackfill(pool: PgQueryable): Promise<void> {
  await pool.query(TEAM_SEAT_LEGACY_POSTGRES_BACKFILL_SQL);
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

async function deduplicatePiSessions(pool: PgQueryable): Promise<void> {
  await pool.query(`
    WITH ranked_sessions AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY user_id, session_id
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS canonical_id
      FROM pi_sessions
    ), duplicate_sessions AS (
      SELECT id AS duplicate_id, canonical_id
      FROM ranked_sessions
      WHERE id != canonical_id
    )
    UPDATE pi_messages AS messages
    SET pi_session_db_id = duplicate_sessions.canonical_id
    FROM duplicate_sessions
    WHERE messages.pi_session_db_id = duplicate_sessions.duplicate_id
  `);

  await pool.query(`
    WITH ranked_sessions AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY user_id, session_id
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS canonical_id
      FROM pi_sessions
    ), affected_sessions AS (
      SELECT DISTINCT canonical_id
      FROM ranked_sessions
      WHERE id != canonical_id
    ), ordered_messages AS (
      SELECT
        messages.id,
        ROW_NUMBER() OVER (
          PARTITION BY messages.pi_session_db_id
          ORDER BY messages.timestamp ASC, messages.id ASC
        ) AS next_sequence
      FROM pi_messages AS messages
      WHERE messages.pi_session_db_id IN (SELECT canonical_id FROM affected_sessions)
    )
    UPDATE pi_messages AS messages
    SET sequence = ordered_messages.next_sequence
    FROM ordered_messages
    WHERE messages.id = ordered_messages.id
  `);

  await pool.query(`
    WITH ranked_sessions AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY user_id, session_id
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS canonical_id
      FROM pi_sessions
    ), duplicate_sessions AS (
      SELECT id AS duplicate_id
      FROM ranked_sessions
      WHERE id != canonical_id
    )
    DELETE FROM pi_sessions AS sessions
    USING duplicate_sessions
    WHERE sessions.id = duplicate_sessions.duplicate_id
  `);

  await pool.query(`
    UPDATE channel_active_sessions AS active_sessions
    SET agent_id = sessions.agent_id
    FROM pi_sessions AS sessions
    WHERE sessions.user_id = active_sessions.user_id
      AND sessions.session_id = active_sessions.session_id
      AND sessions.agent_id != active_sessions.agent_id
  `);

  await pool.query(`
    WITH ranked_active_sessions AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, agent_id, channel_id, channel_session_key, channel_thread_key
          ORDER BY updated_at DESC NULLS LAST, id DESC
        ) AS active_rank
      FROM channel_active_sessions
    )
    DELETE FROM channel_active_sessions AS active_sessions
    USING ranked_active_sessions
    WHERE active_sessions.id = ranked_active_sessions.id
      AND ranked_active_sessions.active_rank > 1
  `);

  await pool.query('DROP INDEX IF EXISTS idx_pi_sessions_user_session');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_sessions_user_session ON pi_sessions (user_id, session_id)');
}

export async function runPostgresMigrations(pool: PgQueryable): Promise<void> {
  if (process.env.CANVAS_POSTGRES_VECTOR_ENABLED === 'true') {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  }

  const tables = getPostgresSchemaTables();
  for (const table of tables) {
    await pool.query(createTableSql(table));
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_yjs_states (
      document_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      organization_id text,
      path text NOT NULL,
      representation text NOT NULL CHECK (representation IN ('plain_text', 'tiptap_xml')),
      lifecycle_generation bigint NOT NULL DEFAULT 1,
      schema_version bigint NOT NULL DEFAULT 1,
      yjs_state bytea NOT NULL,
      state_vector bytea NOT NULL,
      document_sequence bigint NOT NULL DEFAULT 0,
      persisted_at bigint NOT NULL,
      checkpointed_at bigint,
      checkpoint_sequence bigint NOT NULL DEFAULT 0,
      canonical_hash text,
      serialized_hash text,
      newline_style text NOT NULL DEFAULT 'lf' CHECK (newline_style IN ('lf', 'crlf')),
      has_bom bigint NOT NULL DEFAULT 0,
      degraded bigint NOT NULL DEFAULT 0,
      compacted_at bigint,
      compaction_count bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
    )
  `);
  await pool.query("ALTER TABLE collaboration_yjs_states ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'");
  await pool.query('ALTER TABLE collaboration_yjs_states ADD COLUMN IF NOT EXISTS compacted_at bigint');
  await pool.query('ALTER TABLE collaboration_yjs_states ADD COLUMN IF NOT EXISTS compaction_count bigint NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE team_membership_sync_state ADD COLUMN IF NOT EXISTS next_attempt_at bigint');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_yjs_workspace_path ON collaboration_yjs_states (workspace_id, path)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_yjs_persisted ON collaboration_yjs_states (persisted_at)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_yjs_state_backups (
      backup_id text PRIMARY KEY,
      document_id text NOT NULL,
      lifecycle_generation bigint NOT NULL,
      schema_version bigint NOT NULL,
      representation text NOT NULL,
      yjs_state bytea NOT NULL,
      state_vector bytea NOT NULL,
      document_sequence bigint NOT NULL,
      reason text NOT NULL CHECK (reason IN ('compaction', 'representation_change')),
      created_at bigint NOT NULL,
      expires_at bigint NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_yjs_backup_document ON collaboration_yjs_state_backups (document_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_yjs_backup_expiry ON collaboration_yjs_state_backups (expires_at)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_excalidraw_states (
      document_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      organization_id text,
      path text NOT NULL,
      lifecycle_generation bigint NOT NULL DEFAULT 1,
      excalidraw_version text NOT NULL,
      scene_schema_version bigint NOT NULL DEFAULT 1,
      elements_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      shared_app_state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      assets_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      scene_sequence bigint NOT NULL DEFAULT 0,
      checkpoint_sequence bigint NOT NULL DEFAULT 0,
      checkpoint_revision_id text,
      canonical_hash text NOT NULL,
      persisted_at bigint NOT NULL,
      checkpointed_at bigint,
      degraded_reason text,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_excalidraw_workspace_path ON collaboration_excalidraw_states (workspace_id, path)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_excalidraw_persisted ON collaboration_excalidraw_states (persisted_at)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_excalidraw_operations (
      document_id text NOT NULL,
      message_id text NOT NULL,
      lifecycle_generation bigint NOT NULL,
      base_sequence bigint NOT NULL,
      applied_sequence bigint NOT NULL,
      actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
      actor_id text,
      initiated_by_user_id text,
      accepted_delta_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      accepted_app_state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      accepted_delta_hash text NOT NULL,
      result_json jsonb NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (document_id, message_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_excalidraw_operation_sequence ON collaboration_excalidraw_operations (document_id, applied_sequence)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_excalidraw_assets (
      workspace_id text NOT NULL,
      file_id text NOT NULL,
      content_sha256 text NOT NULL,
      mime_type text NOT NULL,
      size_bytes bigint NOT NULL,
      storage_key text NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'available' CHECK (status IN ('uploading', 'available', 'quarantined', 'orphaned')),
      created_at bigint NOT NULL,
      last_referenced_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, file_id)
    )
  `);
  await pool.query('ALTER TABLE collaboration_excalidraw_assets DROP CONSTRAINT IF EXISTS collaboration_excalidraw_assets_workspace_id_content_sha256_key');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_excalidraw_asset_content ON collaboration_excalidraw_assets (workspace_id, content_sha256)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_excalidraw_asset_retention ON collaboration_excalidraw_assets (workspace_id, status, last_referenced_at)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_excalidraw_agent_operations (
      operation_id text PRIMARY KEY,
      document_id text NOT NULL,
      workspace_id text NOT NULL,
      lifecycle_generation bigint NOT NULL,
      observed_scene_sequence bigint NOT NULL,
      initiated_by_user_id text NOT NULL,
      actor_id text NOT NULL,
      idempotency_key text NOT NULL,
      status text NOT NULL,
      patch_json jsonb NOT NULL,
      result_json jsonb,
      review_reason text,
      cas_version bigint NOT NULL DEFAULT 0,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (document_id, initiated_by_user_id, idempotency_key)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_excalidraw_agent_status ON collaboration_excalidraw_agent_operations (document_id, status, updated_at)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_agent_operations (
      operation_id text PRIMARY KEY,
      document_id text NOT NULL,
      workspace_id text NOT NULL,
      organization_id text,
      document_lifecycle_generation bigint NOT NULL DEFAULT 1,
      schema_version bigint NOT NULL DEFAULT 1,
      initiated_by_user_id text NOT NULL,
      actor_id text NOT NULL,
      agent_run_id text,
      actor_session_id text,
      supersedes_operation_id text,
      idempotency_key text NOT NULL,
      run_generation bigint NOT NULL DEFAULT 1,
      payload_hash text NOT NULL,
      operation_type text NOT NULL DEFAULT 'apply',
      requested_mode text NOT NULL DEFAULT 'direct_apply',
      atomicity text NOT NULL DEFAULT 'all_or_nothing',
      operation_payload text,
      reverse_payload text,
      status text NOT NULL,
      base_state_vector bytea NOT NULL,
      base_document_sequence bigint NOT NULL DEFAULT 0,
      resulting_state_vector_hash text,
      checkpoint_revision_id text,
      result_json text,
      cas_version bigint NOT NULL DEFAULT 0,
      cancel_requested_at bigint,
      applied_at bigint,
      persisted_at bigint,
      checkpointed_at bigint,
      expires_at bigint,
      error_code text,
      correlation_id text,
      causation_id text,
      trigger_depth bigint NOT NULL DEFAULT 0,
      expected_canonical_hash text,
      applied_document_sequence bigint,
      action_keys_json text NOT NULL DEFAULT '{}',
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (document_id, initiated_by_user_id, idempotency_key)
    )
  `);
  const collaborationAgentColumns = [
    'organization_id text',
    'document_lifecycle_generation bigint NOT NULL DEFAULT 1',
    'schema_version bigint NOT NULL DEFAULT 1',
    'agent_run_id text',
    'actor_session_id text',
    'supersedes_operation_id text',
    "operation_type text NOT NULL DEFAULT 'apply'",
    "requested_mode text NOT NULL DEFAULT 'direct_apply'",
    "atomicity text NOT NULL DEFAULT 'all_or_nothing'",
    'operation_payload text',
    'reverse_payload text',
    'base_document_sequence bigint NOT NULL DEFAULT 0',
    'resulting_state_vector_hash text',
    'checkpoint_revision_id text',
    'cancel_requested_at bigint',
    'applied_at bigint',
    'persisted_at bigint',
    'checkpointed_at bigint',
    'expires_at bigint',
    'error_code text',
    'correlation_id text',
    'causation_id text',
    'trigger_depth bigint NOT NULL DEFAULT 0',
    'expected_canonical_hash text',
    'applied_document_sequence bigint',
    "action_keys_json text NOT NULL DEFAULT '{}'",
  ];
  for (const column of collaborationAgentColumns) {
    await pool.query(`ALTER TABLE collaboration_agent_operations ADD COLUMN IF NOT EXISTS ${column}`);
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_agent_document_status ON collaboration_agent_operations (document_id, status, updated_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_agent_expiry ON collaboration_agent_operations (status, expires_at)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_agent_sagas (
      saga_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      organization_id text,
      initiated_by_user_id text NOT NULL,
      actor_id text NOT NULL,
      idempotency_key text NOT NULL,
      requested_atomicity text NOT NULL CHECK (requested_atomicity IN ('saga', 'all_or_nothing')),
      status text NOT NULL,
      correlation_id text,
      causation_id text,
      error_code text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (workspace_id, initiated_by_user_id, idempotency_key)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_agent_saga_status ON collaboration_agent_sagas (workspace_id, status, updated_at)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collaboration_agent_saga_documents (
      saga_id text NOT NULL,
      document_id text NOT NULL,
      ordinal bigint NOT NULL,
      operation_id text,
      compensation_operation_id text,
      status text NOT NULL,
      error_code text,
      updated_at bigint NOT NULL,
      PRIMARY KEY (saga_id, document_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_collaboration_agent_saga_document ON collaboration_agent_saga_documents (document_id, status, updated_at)');

  for (const table of tables) {
    const config = getTableConfig(table as never) as { columns: SchemaColumn[] };
    for (const column of config.columns) {
      await pool.query(createColumnAddSql(table, column));
    }
  }

  await deduplicatePiSessions(pool);

  for (const table of tables) {
    const config = getTableConfig(table as never) as {
      columns: SchemaColumn[];
      indexes: Array<Parameters<typeof indexSql>[1]>;
    };

    for (const column of config.columns) {
      const statement = uniqueColumnIndexSql(table, column);
      if (statement) await pool.query(statement);
    }

    for (const index of config.indexes) {
      const statement = indexSql(table, index);
      if (statement) await pool.query(statement);
    }
  }

  for (const statement of STUDIO_WORKSPACE_BACKFILL_STATEMENTS) {
    await pool.query(statement);
  }

  await pool.query('DROP INDEX IF EXISTS idx_canvas_workspaces_personal_owner');
  await pool.query('DROP INDEX IF EXISTS idx_canvas_workspaces_team_organization');
  await pool.query(`
    UPDATE canvas_workspaces
    SET type = 'organization', is_default = 0, updated_at = COALESCE(updated_at, created_at)
    WHERE type = 'team'
      AND (
        LENGTH(root_relative_path) - LENGTH(REPLACE(root_relative_path, '/', '')) = 3
        OR root_relative_path IS NULL
        OR root_relative_path = ''
      )
  `);
  await pool.query(`
    UPDATE canvas_workspaces w
    SET is_default = 1
    WHERE type = 'personal'
      AND owner_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM canvas_workspaces older
        WHERE older.type = 'personal'
          AND older.owner_user_id = w.owner_user_id
          AND (
            older.created_at < w.created_at
            OR (older.created_at = w.created_at AND older.id < w.id)
          )
      )
  `);
  await pool.query(`
    UPDATE canvas_workspaces
    SET is_default = 0
    WHERE type = 'organization'
  `);
  await pool.query('DROP INDEX IF EXISTS idx_canvas_workspaces_default_organization');

  for (const table of tables) {
    const config = getTableConfig(table as never) as {
      foreignKeys: Array<Parameters<typeof foreignKeySql>[1]>;
    };
    for (const foreignKey of config.foreignKeys) {
      await pool.query(foreignKeySql(table, foreignKey));
    }
  }

  await runPostgresTeamSeatLegacyBackfill(pool);

  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `
      INSERT INTO agents (agent_id, name, type, removable, created_at, updated_at)
      VALUES ('canvas-agent', 'Canvas Agent', 'main', 0, $1, $2)
      ON CONFLICT (agent_id) DO NOTHING
    `,
    [now, now],
  );
  await pool.query(
    `
      INSERT INTO agent_members (
        agent_id, organization_id, user_id, role, status,
        can_use, can_edit, can_manage, invited_by_user_id, created_at, updated_at
      )
      SELECT
        a.agent_id,
        p.organization_id,
        p.user_id,
        CASE WHEN p.role IN ('owner', 'admin') THEN 'manager' ELSE 'editor' END,
        'active',
        1,
        1,
        CASE WHEN p.role IN ('owner', 'admin') THEN 1 ELSE 0 END,
        NULL,
        $1,
        $2
      FROM agents a
      JOIN organization_user_permissions p
        ON p.status = 'active' AND p.role != 'external'
      LEFT JOIN "user" u ON u.id = p.user_id
      WHERE a.type != 'main'
        AND a.access_policy = 'legacy'
        AND COALESCE(u.banned, 0) = 0
      ON CONFLICT (agent_id, user_id) DO NOTHING
    `,
    [now, now],
  );
  await pool.query(`
    UPDATE agents
    SET access_policy = 'restricted'
    WHERE type != 'main' AND access_policy = 'legacy'
  `);
  await pool.query(`
    UPDATE agents
    SET scope_type = 'system', organization_id = NULL, owner_user_id = NULL
    WHERE type = 'main'
  `);
  await pool.query(`
    UPDATE agents a
    SET
      scope_type = 'organization',
      organization_id = source.organization_id,
      owner_user_id = NULL,
      created_by_user_id = COALESCE(a.created_by_user_id, source.manager_user_id)
    FROM (
      SELECT
        m.agent_id,
        MIN(m.organization_id) AS organization_id,
        MIN(CASE WHEN m.can_manage = 1 THEN m.user_id ELSE NULL END) AS manager_user_id
      FROM agent_members m
      WHERE m.status = 'active'
      GROUP BY m.agent_id
    ) source
    WHERE a.agent_id = source.agent_id
      AND a.type != 'main'
      AND a.created_by_user_id IS NULL
  `);
}
