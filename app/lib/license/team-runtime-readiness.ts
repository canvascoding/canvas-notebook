import 'server-only';

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  resolveDataDir,
  resolveDatabaseProviderConfig,
  resolveDatabaseProviderGate,
} from '@/app/lib/db/provider';

export type TeamRuntimeReadinessArea =
  | 'database'
  | 'migration'
  | 'pgvector'
  | 'capability'
  | 'organization'
  | 'storage'
  | 'version';

export type TeamRuntimeReadinessCheckStatus = 'ready' | 'blocked' | 'not_checked';

export type TeamRuntimeReadinessCode =
  | 'TEAM_RUNTIME_DATABASE_READY'
  | 'TEAM_RUNTIME_DATABASE_POSTGRES_REQUIRED'
  | 'TEAM_RUNTIME_DATABASE_CONFIG_INVALID'
  | 'TEAM_RUNTIME_DATABASE_UNREACHABLE'
  | 'TEAM_RUNTIME_MIGRATIONS_READY'
  | 'TEAM_RUNTIME_MIGRATIONS_INCOMPLETE'
  | 'TEAM_RUNTIME_MIGRATIONS_NOT_CHECKED'
  | 'TEAM_RUNTIME_PGVECTOR_READY'
  | 'TEAM_RUNTIME_PGVECTOR_NOT_CONFIGURED'
  | 'TEAM_RUNTIME_PGVECTOR_UNAVAILABLE'
  | 'TEAM_RUNTIME_PGVECTOR_NOT_CHECKED'
  | 'TEAM_RUNTIME_CAPABILITIES_READY'
  | 'TEAM_RUNTIME_CAPABILITIES_UNAVAILABLE'
  | 'TEAM_RUNTIME_CAPABILITIES_NOT_CHECKED'
  | 'TEAM_RUNTIME_ORGANIZATION_READY'
  | 'TEAM_RUNTIME_ORGANIZATION_NOT_READY'
  | 'TEAM_RUNTIME_ORGANIZATION_NOT_CHECKED'
  | 'TEAM_RUNTIME_STORAGE_READY'
  | 'TEAM_RUNTIME_STORAGE_UNWRITABLE'
  | 'TEAM_RUNTIME_VERSION_SUPPORTED'
  | 'TEAM_RUNTIME_NOTEBOOK_UPDATE_REQUIRED';

export type TeamRuntimeReadinessCheck = {
  area: TeamRuntimeReadinessArea;
  status: TeamRuntimeReadinessCheckStatus;
  code: TeamRuntimeReadinessCode;
  message: string;
};

export type TeamRuntimeReadinessStatus = {
  ready: boolean;
  checkedAt: string;
  databaseEngine: 'postgres' | 'sqlite' | 'other';
  pgvectorVersion: string | null;
  checks: TeamRuntimeReadinessCheck[];
  blockers: Array<{ code: TeamRuntimeReadinessCode; message: string }>;
};

export type PostgresTeamRuntimeProbe = {
  databaseReachable: boolean;
  migrationsReady: boolean;
  pgvectorAvailable: boolean;
  pgvectorVersion: string | null;
  organizationReady: boolean;
};

type TeamRuntimeReadinessOptions = {
  now?: Date;
  postgresProbe?: () => Promise<PostgresTeamRuntimeProbe>;
  storageProbe?: () => Promise<boolean>;
};

const REQUIRED_POSTGRES_COLUMNS = [
  ['user', 'id'],
  ['canvas_organization_settings', 'organization_id'],
  ['canvas_organization_settings', 'owner_user_id'],
  ['canvas_workspaces', 'organization_id'],
  ['canvas_workspaces', 'type'],
  ['organization_user_permissions', 'organization_id'],
  ['organization_user_permissions', 'user_id'],
  ['organization_user_permissions', 'role'],
  ['organization_user_permissions', 'status'],
  ['team_memberships', 'membership_revision'],
  ['team_memberships', 'status'],
  ['team_membership_transitions', 'membership_revision'],
  ['team_membership_sync_state', 'current_revision'],
  ['team_seat_outbox', 'membership_revision'],
  ['team_seat_outbox', 'status'],
] as const;

function check(
  area: TeamRuntimeReadinessArea,
  status: TeamRuntimeReadinessCheckStatus,
  code: TeamRuntimeReadinessCode,
  message: string,
): TeamRuntimeReadinessCheck {
  return { area, status, code, message };
}

function databaseEngine(): TeamRuntimeReadinessStatus['databaseEngine'] {
  const configured = process.env.CANVAS_DATABASE_PROVIDER?.trim().toLowerCase();
  if (!configured || configured === 'sqlite') return 'sqlite';
  if (configured === 'postgres') return 'postgres';
  return 'other';
}

function requiredColumnsSql(): string {
  const values = REQUIRED_POSTGRES_COLUMNS
    .map(([tableName, columnName]) => `('${tableName}', '${columnName}')`)
    .join(',\n');
  return `
    WITH required(table_name, column_name) AS (
      VALUES ${values}
    )
    SELECT COUNT(*)::bigint AS missing_count
    FROM required
    LEFT JOIN information_schema.columns existing
      ON existing.table_schema = 'public'
      AND existing.table_name = required.table_name
      AND existing.column_name = required.column_name
    WHERE existing.column_name IS NULL
  `;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return null;
}

async function inspectPostgresRuntime(): Promise<PostgresTeamRuntimeProbe> {
  const { openDb } = await import('@/app/lib/db');
  let database: Awaited<ReturnType<typeof openDb>> | null = null;
  try {
    database = await openDb();
    await database.get('SELECT 1 AS ready');
  } catch (error) {
    console.warn('[license/team-readiness] Postgres connection check failed', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    try {
      await database?.close();
    } catch {
      // The failed connection probe has no additional recoverable action.
    }
    return {
      databaseReachable: false,
      migrationsReady: false,
      pgvectorAvailable: false,
      pgvectorVersion: null,
      organizationReady: false,
    };
  }

  try {
    let migrationsReady = false;
    try {
      const migrationRow = await database.get(requiredColumnsSql()) as {
        missing_count?: unknown;
      } | undefined;
      migrationsReady = numericValue(migrationRow?.missing_count) === 0;
    } catch (error) {
      console.warn('[license/team-readiness] Postgres schema check failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    let pgvectorVersion: string | null = null;
    try {
      const vectorRow = await database.get(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1",
      ) as { extversion?: unknown } | undefined;
      pgvectorVersion = typeof vectorRow?.extversion === 'string'
        ? vectorRow.extversion
        : null;
    } catch (error) {
      console.warn('[license/team-readiness] pgvector extension check failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    let organizationReady = false;
    if (migrationsReady) {
      try {
        const organizationRow = await database.get(`
          SELECT
            organization.organization_id,
            organization.owner_user_id,
            owner.id AS owner_exists,
            permission.role AS owner_role,
            COALESCE(permission.status, 'active') AS owner_status
          FROM canvas_organization_settings organization
          LEFT JOIN "user" owner
            ON owner.id = organization.owner_user_id
          LEFT JOIN organization_user_permissions permission
            ON permission.organization_id = organization.organization_id
            AND permission.user_id = organization.owner_user_id
          ORDER BY organization.created_at ASC
          LIMIT 1
        `) as {
          organization_id?: unknown;
          owner_user_id?: unknown;
          owner_exists?: unknown;
          owner_role?: unknown;
          owner_status?: unknown;
        } | undefined;
        organizationReady = typeof organizationRow?.organization_id === 'string'
          && typeof organizationRow.owner_user_id === 'string'
          && organizationRow.owner_exists === organizationRow.owner_user_id
          && organizationRow.owner_role === 'owner'
          && organizationRow.owner_status === 'active';
      } catch (error) {
        console.warn('[license/team-readiness] organization readiness check failed', {
          error: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }

    return {
      databaseReachable: true,
      migrationsReady,
      pgvectorAvailable: Boolean(pgvectorVersion),
      pgvectorVersion,
      organizationReady,
    };
  } finally {
    await database.close();
  }
}

async function inspectStorageWriteability(): Promise<boolean> {
  const dataRoot = path.resolve(resolveDataDir());
  const probePath = path.join(
    dataRoot,
    `.team-runtime-readiness-${process.pid}-${randomUUID()}`,
  );
  let probe: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await access(dataRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    probe = await open(probePath, 'wx', 0o600);
    await probe.writeFile('team-runtime-readiness\n', 'utf8');
    await probe.sync();
    return true;
  } catch (error) {
    console.warn('[license/team-readiness] storage write check failed', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return false;
  } finally {
    await probe?.close().catch(() => {});
    await rm(probePath, { force: true }).catch(() => {});
  }
}

function finalizeReadiness(
  checkedAt: string,
  engine: TeamRuntimeReadinessStatus['databaseEngine'],
  pgvectorVersion: string | null,
  checks: TeamRuntimeReadinessCheck[],
): TeamRuntimeReadinessStatus {
  const blockers = checks
    .filter((entry) => entry.status === 'blocked')
    .map((entry) => ({ code: entry.code, message: entry.message }));
  return {
    ready: blockers.length === 0,
    checkedAt,
    databaseEngine: engine,
    pgvectorVersion,
    checks,
    blockers,
  };
}

export async function getCommunityTeamRuntimeReadiness(
  options: TeamRuntimeReadinessOptions = {},
): Promise<TeamRuntimeReadinessStatus> {
  const now = options.now ?? new Date();
  const engine = databaseEngine();
  const config = resolveDatabaseProviderConfig();
  const checks: TeamRuntimeReadinessCheck[] = [];
  let postgres: PostgresTeamRuntimeProbe | null = null;

  if (engine !== 'postgres') {
    checks.push(check(
      'database',
      'blocked',
      'TEAM_RUNTIME_DATABASE_POSTGRES_REQUIRED',
      'Community Team requires PostgreSQL. Configure and migrate this SQLite installation before upgrading.',
    ));
  } else if (config.problems.length > 0) {
    checks.push(check(
      'database',
      'blocked',
      'TEAM_RUNTIME_DATABASE_CONFIG_INVALID',
      `The PostgreSQL configuration is incomplete (${config.problems.map((problem) => problem.code).join(', ')}).`,
    ));
  } else {
    try {
      postgres = await (options.postgresProbe ?? inspectPostgresRuntime)();
    } catch (error) {
      console.warn('[license/team-readiness] Postgres runtime probe failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      });
      postgres = {
        databaseReachable: false,
        migrationsReady: false,
        pgvectorAvailable: false,
        pgvectorVersion: null,
        organizationReady: false,
      };
    }
    checks.push(postgres.databaseReachable
      ? check(
          'database',
          'ready',
          'TEAM_RUNTIME_DATABASE_READY',
          'PostgreSQL is configured and reachable.',
        )
      : check(
          'database',
          'blocked',
          'TEAM_RUNTIME_DATABASE_UNREACHABLE',
          'PostgreSQL is configured but the Notebook runtime cannot reach it.',
        ));
  }

  if (!postgres?.databaseReachable) {
    checks.push(check(
      'migration',
      'not_checked',
      'TEAM_RUNTIME_MIGRATIONS_NOT_CHECKED',
      'Team database migrations cannot be checked until PostgreSQL is reachable.',
    ));
  } else {
    checks.push(postgres.migrationsReady
      ? check(
          'migration',
          'ready',
          'TEAM_RUNTIME_MIGRATIONS_READY',
          'The required Team membership and workspace schema is installed.',
        )
      : check(
          'migration',
          'blocked',
          'TEAM_RUNTIME_MIGRATIONS_INCOMPLETE',
          'Required Team membership or workspace database migrations are missing.',
        ));
  }

  if (!config.postgres.pgvectorEnabled) {
    checks.push(check(
      'pgvector',
      'blocked',
      'TEAM_RUNTIME_PGVECTOR_NOT_CONFIGURED',
      'Community Team requires pgvector; enable CANVAS_POSTGRES_VECTOR_ENABLED and run migrations.',
    ));
  } else if (!postgres?.databaseReachable) {
    checks.push(check(
      'pgvector',
      'not_checked',
      'TEAM_RUNTIME_PGVECTOR_NOT_CHECKED',
      'pgvector cannot be checked until PostgreSQL is reachable.',
    ));
  } else {
    checks.push(postgres.pgvectorAvailable
      ? check(
          'pgvector',
          'ready',
          'TEAM_RUNTIME_PGVECTOR_READY',
          `pgvector ${postgres.pgvectorVersion ?? ''} is available.`.trim(),
        )
      : check(
          'pgvector',
          'blocked',
          'TEAM_RUNTIME_PGVECTOR_UNAVAILABLE',
          'CANVAS_POSTGRES_VECTOR_ENABLED is set, but the vector extension is not installed.',
        ));
  }

  const capabilityGate = resolveDatabaseProviderGate({
    runtimeMode: 'team',
    teamFeaturesEnabled: true,
    requirePgvector: true,
    requiredCapabilities: [
      'multiUser',
      'teamWorkspace',
      'vectorSearch',
      'liveCollaboration',
    ],
    vectorProvider: 'pgvector',
    postgresRuntimeAdapterAvailable: true,
  });
  const capabilitiesReady = engine === 'postgres'
    && capabilityGate.ok
    && postgres?.databaseReachable === true
    && postgres.migrationsReady
    && postgres.pgvectorAvailable;
  if (engine !== 'postgres' || !postgres?.databaseReachable) {
    checks.push(check(
      'capability',
      'not_checked',
      'TEAM_RUNTIME_CAPABILITIES_NOT_CHECKED',
      'Team capabilities cannot be checked until the PostgreSQL runtime is ready.',
    ));
  } else {
    checks.push(capabilitiesReady
      ? check(
          'capability',
          'ready',
          'TEAM_RUNTIME_CAPABILITIES_READY',
          'Multi-user, Team workspace, vector search and live collaboration prerequisites are ready.',
        )
      : check(
          'capability',
          'blocked',
          'TEAM_RUNTIME_CAPABILITIES_UNAVAILABLE',
          'One or more required Team runtime capabilities are not available.',
        ));
  }

  if (!postgres?.databaseReachable || !postgres.migrationsReady) {
    checks.push(check(
      'organization',
      'not_checked',
      'TEAM_RUNTIME_ORGANIZATION_NOT_CHECKED',
      'The Team owner and organization state cannot be checked before database migrations are ready.',
    ));
  } else {
    checks.push(postgres.organizationReady
      ? check(
          'organization',
          'ready',
          'TEAM_RUNTIME_ORGANIZATION_READY',
          'The local organization has one active owner.',
        )
      : check(
          'organization',
          'blocked',
          'TEAM_RUNTIME_ORGANIZATION_NOT_READY',
          'The local organization needs one active owner before Team can be enabled.',
        ));
  }

  let storageReady = false;
  try {
    storageReady = await (options.storageProbe ?? inspectStorageWriteability)();
  } catch (error) {
    console.warn('[license/team-readiness] storage runtime probe failed', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  checks.push(storageReady
    ? check(
        'storage',
        'ready',
        'TEAM_RUNTIME_STORAGE_READY',
        'The Notebook data storage is writable.',
      )
    : check(
        'storage',
        'blocked',
        'TEAM_RUNTIME_STORAGE_UNWRITABLE',
        'The Notebook data storage is not writable by the server process.',
      ));

  return finalizeReadiness(
    now.toISOString(),
    engine,
    postgres?.pgvectorVersion ?? null,
    checks,
  );
}

export function withCommunityTeamVersionReadiness(
  status: TeamRuntimeReadinessStatus,
  version: {
    current: string;
    minimum: string | null;
    supported: boolean;
  },
): TeamRuntimeReadinessStatus {
  const checks = status.checks.filter((entry) => entry.area !== 'version');
  checks.push(version.supported
    ? check(
        'version',
        'ready',
        'TEAM_RUNTIME_VERSION_SUPPORTED',
        version.minimum
          ? `Canvas Notebook ${version.current} satisfies the minimum Team version ${version.minimum}.`
          : `Canvas Notebook ${version.current} is supported for Team.`,
      )
    : check(
        'version',
        'blocked',
        'TEAM_RUNTIME_NOTEBOOK_UPDATE_REQUIRED',
        `Update Canvas Notebook to ${version.minimum ?? 'a supported version'} before upgrading to Team.`,
      ));
  return finalizeReadiness(
    status.checkedAt,
    status.databaseEngine,
    status.pgvectorVersion,
    checks,
  );
}
