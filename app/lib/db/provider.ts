import path from 'node:path';

import {
  normalizeVectorProvider,
  resolveNotebookRuntimeProfile,
  type NotebookRuntimeCapabilityKey,
  type NotebookRuntimeCompatibilityCode,
  type NotebookVectorProvider,
} from '@/app/lib/runtime/notebook-runtime';

export type DatabaseProvider = 'sqlite' | 'postgres';

export type DatabaseProviderProblemCode =
  | 'invalid_provider'
  | 'postgres_missing_database_url'
  | 'postgres_invalid_database_url'
  | 'postgres_runtime_adapter_unavailable'
  | NotebookRuntimeCompatibilityCode;

export type DatabaseProviderProblem = {
  code: DatabaseProviderProblemCode;
  message: string;
};

export type DatabaseRuntimeAdapter = 'sqlite' | 'postgres' | 'postgres-unavailable';

export type DatabaseProviderConfig = {
  provider: DatabaseProvider;
  requestedProvider: string | null;
  vectorProvider: NotebookVectorProvider;
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
  vectorProvider: NotebookVectorProvider;
  runtimeAdapter: DatabaseProviderConfig['runtimeAdapter'];
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
  const pgvectorEnabled = isTruthyEnv(process.env.CANVAS_POSTGRES_VECTOR_ENABLED);
  const vectorProvider = normalizeVectorProvider(process.env.CANVAS_VECTOR_PROVIDER) || (pgvectorEnabled ? 'pgvector' : 'none');

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
    vectorProvider,
    runtimeAdapter: provider === 'postgres' ? 'postgres' : 'sqlite',
    sqlite: {
      dataDir: resolveDataDir(),
      path: sqlitePath,
    },
    postgres: {
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL?.trim()),
      databaseUrlProtocol,
      pgvectorEnabled,
      imageConfigured: Boolean(process.env.CANVAS_POSTGRES_IMAGE?.trim()),
      dataVolumeConfigured: Boolean(process.env.CANVAS_POSTGRES_DATA_VOLUME?.trim()),
    },
    problems,
  };
}

export function resolveDatabaseProviderGate(options: {
  runtimeMode?: 'personal' | 'team';
  teamFeaturesEnabled?: boolean;
  requirePgvector?: boolean;
  requiredCapabilities?: NotebookRuntimeCapabilityKey[];
  vectorProvider?: NotebookVectorProvider;
  postgresRuntimeAdapterAvailable?: boolean;
} = {}): DatabaseProviderGate {
  const config = resolveDatabaseProviderConfig();
  const blockers = [...config.problems];
  const warnings: DatabaseProviderProblem[] = [];
  const postgresRuntimeAdapterAvailable = options.postgresRuntimeAdapterAvailable !== false;
  const runtimeAdapter: DatabaseRuntimeAdapter = config.provider === 'postgres' && postgresRuntimeAdapterAvailable
    ? 'postgres'
    : config.runtimeAdapter;
  const requiredCapabilities = new Set(options.requiredCapabilities || []);
  const runtimeProfile = resolveNotebookRuntimeProfile({
    runtimeMode: options.runtimeMode || (options.teamFeaturesEnabled ? 'team' : 'personal'),
    databaseProvider: config.provider,
    vectorProvider: options.vectorProvider || config.vectorProvider,
    capabilities: {
      multiUser: options.teamFeaturesEnabled === true || requiredCapabilities.has('multiUser'),
      teamWorkspace: options.teamFeaturesEnabled === true || requiredCapabilities.has('teamWorkspace'),
      vectorSearch: options.requirePgvector === true || requiredCapabilities.has('vectorSearch'),
      liveCollaboration: requiredCapabilities.has('liveCollaboration'),
    },
    pgvectorEnabled: config.postgres.pgvectorEnabled,
  });
  for (const problem of runtimeProfile.blockers) {
    blockers.push(createProblem(problem.code, problem.message));
  }

  if (config.provider === 'postgres' && !postgresRuntimeAdapterAvailable) {
    blockers.push(createProblem(
      'postgres_runtime_adapter_unavailable',
      'Postgres provider is configured, but this build still uses the SQLite runtime adapter.',
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
    vectorProvider: gate.config.vectorProvider,
    runtimeAdapter: gate.runtimeAdapter,
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
  const gate = resolveDatabaseProviderGate({ postgresRuntimeAdapterAvailable: true });
  if (provider === 'postgres' && !gate.ok) {
    const problem = gate.blockers[0];
    throw new DatabaseProviderRuntimeError(
      problem?.code || 'postgres_missing_database_url',
      problem?.message || 'Postgres mode is configured but not usable.',
    );
  }
}
