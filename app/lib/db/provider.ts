import path from 'node:path';

export type DatabaseProvider = 'sqlite' | 'postgres';

export type DatabaseProviderProblemCode =
  | 'invalid_provider'
  | 'team_requires_postgres'
  | 'postgres_missing_database_url'
  | 'postgres_invalid_database_url'
  | 'postgres_runtime_adapter_unavailable'
  | 'pgvector_required';

export type DatabaseProviderProblem = {
  code: DatabaseProviderProblemCode;
  message: string;
};

export type DatabaseRuntimeAdapter = 'sqlite' | 'postgres' | 'postgres-unavailable';

export type DatabaseProviderConfig = {
  provider: DatabaseProvider;
  requestedProvider: string | null;
  runtimeAdapter: DatabaseRuntimeAdapter;
  sqlite: {
    dataDir: string;
    path: string;
  };
  postgres: {
    databaseUrlConfigured: boolean;
    databaseUrlProtocol: string | null;
    pgvectorEnabled: boolean;
    imageConfigured: boolean;
    dataVolumeConfigured: boolean;
  };
  problems: DatabaseProviderProblem[];
};

export type DatabaseProviderGate = {
  ok: boolean;
  provider: DatabaseProvider;
  runtimeAdapter: DatabaseProviderConfig['runtimeAdapter'];
  blockers: DatabaseProviderProblem[];
  warnings: DatabaseProviderProblem[];
  config: DatabaseProviderConfig;
};

export type PublicDatabaseProviderStatus = {
  provider: DatabaseProvider;
  requestedProvider: string | null;
  runtimeAdapter: DatabaseProviderConfig['runtimeAdapter'];
  sqlite: {
    pathConfigured: boolean;
  };
  postgres: DatabaseProviderConfig['postgres'];
  blockers: DatabaseProviderProblemCode[];
  warnings: DatabaseProviderProblemCode[];
};

const VALID_PROVIDERS = new Set<DatabaseProvider>(['sqlite', 'postgres']);

function normalizeEnvValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function isTruthyEnv(value: string | null | undefined): boolean {
  const normalized = normalizeEnvValue(value);
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function createProblem(code: DatabaseProviderProblemCode, message: string): DatabaseProviderProblem {
  return { code, message };
}

function getDatabaseUrlProtocol(databaseUrl: string | null | undefined): string | null {
  const trimmed = databaseUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol.replace(/:$/u, '').toLowerCase() || null;
  } catch {
    return 'invalid';
  }
}

export function resolveDataDir(): string {
  return process.env.DATA || path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'data');
}

export function resolveSqlitePath(): string {
  return path.join(resolveDataDir(), 'sqlite.db');
}

export function normalizeDatabaseProvider(value?: string | null): DatabaseProvider {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return 'sqlite';
  return VALID_PROVIDERS.has(normalized as DatabaseProvider)
    ? normalized as DatabaseProvider
    : 'sqlite';
}

export function getDatabaseProvider(): DatabaseProvider {
  return normalizeDatabaseProvider(process.env.CANVAS_DATABASE_PROVIDER);
}

export function resolveDatabaseProviderConfig(): DatabaseProviderConfig {
  const requestedProvider = normalizeEnvValue(process.env.CANVAS_DATABASE_PROVIDER);
  const provider = normalizeDatabaseProvider(requestedProvider);
  const problems: DatabaseProviderProblem[] = [];
  const sqlitePath = resolveSqlitePath();
  const databaseUrlProtocol = getDatabaseUrlProtocol(process.env.DATABASE_URL);

  if (requestedProvider && !VALID_PROVIDERS.has(requestedProvider as DatabaseProvider)) {
    problems.push(createProblem(
      'invalid_provider',
      `Unsupported CANVAS_DATABASE_PROVIDER "${requestedProvider}". Use "sqlite" or "postgres".`,
    ));
  }

  if (provider === 'postgres') {
    if (!process.env.DATABASE_URL?.trim()) {
      problems.push(createProblem(
        'postgres_missing_database_url',
        'Postgres mode requires DATABASE_URL.',
      ));
    } else if (databaseUrlProtocol !== 'postgres' && databaseUrlProtocol !== 'postgresql') {
      problems.push(createProblem(
        'postgres_invalid_database_url',
        'DATABASE_URL must use postgres:// or postgresql:// in Postgres mode.',
      ));
    }
  }

  return {
    provider,
    requestedProvider,
    runtimeAdapter: provider === 'postgres' ? 'postgres-unavailable' : 'sqlite',
    sqlite: {
      dataDir: resolveDataDir(),
      path: sqlitePath,
    },
    postgres: {
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL?.trim()),
      databaseUrlProtocol,
      pgvectorEnabled: isTruthyEnv(process.env.CANVAS_POSTGRES_VECTOR_ENABLED),
      imageConfigured: Boolean(process.env.CANVAS_POSTGRES_IMAGE?.trim()),
      dataVolumeConfigured: Boolean(process.env.CANVAS_POSTGRES_DATA_VOLUME?.trim()),
    },
    problems,
  };
}

export function resolveDatabaseProviderGate(options: {
  teamFeaturesEnabled?: boolean;
  requirePgvector?: boolean;
  postgresRuntimeAdapterAvailable?: boolean;
} = {}): DatabaseProviderGate {
  const config = resolveDatabaseProviderConfig();
  const blockers = [...config.problems];
  const warnings: DatabaseProviderProblem[] = [];
  const postgresRuntimeAdapterAvailable = options.postgresRuntimeAdapterAvailable === true;
  const runtimeAdapter: DatabaseRuntimeAdapter = config.provider === 'postgres' && postgresRuntimeAdapterAvailable
    ? 'postgres'
    : config.runtimeAdapter;

  if (options.teamFeaturesEnabled === true && config.provider !== 'postgres') {
    blockers.push(createProblem(
      'team_requires_postgres',
      'Team features require CANVAS_DATABASE_PROVIDER=postgres.',
    ));
  }

  if (config.provider === 'postgres' && !postgresRuntimeAdapterAvailable) {
    blockers.push(createProblem(
      'postgres_runtime_adapter_unavailable',
      'Postgres provider is configured, but this build still uses the SQLite runtime adapter.',
    ));
  }

  if (options.requirePgvector === true && config.provider === 'postgres' && !config.postgres.pgvectorEnabled) {
    blockers.push(createProblem(
      'pgvector_required',
      'This feature requires CANVAS_POSTGRES_VECTOR_ENABLED=true.',
    ));
  }

  return {
    ok: blockers.length === 0,
    provider: config.provider,
    runtimeAdapter,
    blockers,
    warnings,
    config,
  };
}

export function getDatabaseProviderProblemMessages(problems: DatabaseProviderProblem[]): string[] {
  return problems.map((problem) => problem.message);
}

export function toPublicDatabaseProviderStatus(gate: DatabaseProviderGate): PublicDatabaseProviderStatus {
  return {
    provider: gate.provider,
    requestedProvider: gate.config.requestedProvider,
    runtimeAdapter: gate.runtimeAdapter,
    sqlite: {
      pathConfigured: Boolean(gate.config.sqlite.path),
    },
    postgres: gate.config.postgres,
    blockers: gate.blockers.map((problem) => problem.code),
    warnings: gate.warnings.map((problem) => problem.code),
  };
}

export class DatabaseProviderRuntimeError extends Error {
  constructor(
    public readonly code: DatabaseProviderProblemCode,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseProviderRuntimeError';
  }
}

export function assertRuntimeDatabaseProviderSupported(provider = getDatabaseProvider()): void {
  if (provider !== 'sqlite') {
    throw new DatabaseProviderRuntimeError(
      'postgres_runtime_adapter_unavailable',
      'Postgres mode is configured, but the Canvas Notebook runtime database adapter is not available yet.',
    );
  }
}
