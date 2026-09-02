import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type EnvSnapshot = {
  DATA?: string;
  CANVAS_DATABASE_PROVIDER?: string;
  CANVAS_VECTOR_PROVIDER?: string;
  CANVAS_POSTGRES_VECTOR_ENABLED?: string;
  CANVAS_POSTGRES_IMAGE?: string;
  CANVAS_POSTGRES_DATA_VOLUME?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
  NEXT_PHASE?: string;
};

const mutableProcessEnv = process.env as Record<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return {
    DATA: process.env.DATA,
    CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
    CANVAS_VECTOR_PROVIDER: process.env.CANVAS_VECTOR_PROVIDER,
    CANVAS_POSTGRES_VECTOR_ENABLED: process.env.CANVAS_POSTGRES_VECTOR_ENABLED,
    CANVAS_POSTGRES_IMAGE: process.env.CANVAS_POSTGRES_IMAGE,
    CANVAS_POSTGRES_DATA_VOLUME: process.env.CANVAS_POSTGRES_DATA_VOLUME,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PHASE: process.env.NEXT_PHASE,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete mutableProcessEnv[key];
    else mutableProcessEnv[key] = value;
  }
}

function resetProviderEnv(dataDir: string): void {
  process.env.DATA = dataDir;
  delete process.env.CANVAS_DATABASE_PROVIDER;
  delete process.env.CANVAS_VECTOR_PROVIDER;
  delete process.env.CANVAS_POSTGRES_VECTOR_ENABLED;
  delete process.env.CANVAS_POSTGRES_IMAGE;
  delete process.env.CANVAS_POSTGRES_DATA_VOLUME;
  delete process.env.DATABASE_URL;
  delete mutableProcessEnv.NODE_ENV;
  delete mutableProcessEnv.NEXT_PHASE;
}

async function main() {
  const snapshot = snapshotEnv();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-db-provider-'));

  try {
    resetProviderEnv(dataDir);
    const {
      assertRuntimeDatabaseProviderSupported,
      getDatabaseProvider,
      resolveDatabaseProviderConfig,
      resolveDatabaseProviderGate,
      resolveSqlitePath,
      toPublicDatabaseProviderStatus,
    } = await import('../app/lib/db/provider');
    const { resolveNotebookRuntimeProfile } = await import('../app/lib/runtime/notebook-runtime');

    const capabilityDrivenProfile = resolveNotebookRuntimeProfile({
      capabilities: {
        multiUser: true,
        teamWorkspace: true,
        vectorSearch: true,
        liveCollaboration: false,
      },
    });
    assert.equal(capabilityDrivenProfile.runtimeMode, 'team');
    assert.equal(capabilityDrivenProfile.databaseProvider, 'postgres');
    assert.equal(capabilityDrivenProfile.vectorProvider, 'pgvector');
    assert.equal(capabilityDrivenProfile.compatible, true);

    assert.equal(getDatabaseProvider(), 'sqlite');
    assert.equal(resolveSqlitePath(), path.join(dataDir, 'sqlite.db'));
    let config = resolveDatabaseProviderConfig();
    assert.equal(config.provider, 'sqlite');
    assert.equal(config.runtimeAdapter, 'sqlite');
    assert.deepEqual(config.problems, []);

    process.env.DATA = './data';
    assert.equal(resolveSqlitePath(), path.join(process.cwd(), 'data', 'sqlite.db'));
    resetProviderEnv(dataDir);

    let gate = resolveDatabaseProviderGate({ teamFeaturesEnabled: false });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.blockers, []);
    assert.doesNotThrow(() => assertRuntimeDatabaseProviderSupported());

    mutableProcessEnv.NODE_ENV = 'production';
    mutableProcessEnv.NEXT_PHASE = 'phase-production-build';
    assert.equal(getDatabaseProvider(), 'sqlite');
    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    assert.equal(getDatabaseProvider(), 'sqlite');
    config = resolveDatabaseProviderConfig();
    assert.equal(config.provider, 'sqlite');
    assert.equal(config.requestedProvider, 'postgres');
    assert.deepEqual(config.problems, []);
    assert.doesNotThrow(() => assertRuntimeDatabaseProviderSupported());
    delete mutableProcessEnv.NEXT_PHASE;
    assert.equal(getDatabaseProvider(), 'postgres');
    config = resolveDatabaseProviderConfig();
    assert.ok(config.problems.some((problem) => problem.code === 'postgres_missing_database_url'));
    assert.throws(
      () => assertRuntimeDatabaseProviderSupported(),
      /requires DATABASE_URL/u,
    );
    delete process.env.CANVAS_DATABASE_PROVIDER;
    await writeFile(resolveSqlitePath(), 'legacy-sqlite-marker');
    assert.equal(getDatabaseProvider(), 'sqlite');
    await rm(resolveSqlitePath(), { force: true });
    process.env.DATABASE_URL = 'postgresql://canvas:secret@postgres:5432/canvas_notebook';
    assert.equal(getDatabaseProvider(), 'postgres');
    resetProviderEnv(dataDir);

    gate = resolveDatabaseProviderGate({ teamFeaturesEnabled: true });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((problem) => problem.code === 'team_requires_postgres'));

    process.env.CANVAS_DATABASE_PROVIDER = 'mysql';
    config = resolveDatabaseProviderConfig();
    assert.equal(config.provider, 'sqlite');
    assert.equal(config.requestedProvider, 'mysql');
    assert.ok(config.problems.some((problem) => problem.code === 'invalid_provider'));

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    delete process.env.DATABASE_URL;
    gate = resolveDatabaseProviderGate({ teamFeaturesEnabled: true });
    assert.equal(gate.ok, false);
    assert.equal(gate.runtimeAdapter, 'postgres');
    assert.ok(gate.blockers.some((problem) => problem.code === 'postgres_missing_database_url'));
    assert.throws(
      () => assertRuntimeDatabaseProviderSupported(),
      /requires DATABASE_URL/u,
    );

    process.env.DATABASE_URL = 'mysql://canvas:secret@localhost/canvas';
    gate = resolveDatabaseProviderGate({ teamFeaturesEnabled: true });
    assert.ok(gate.blockers.some((problem) => problem.code === 'postgres_invalid_database_url'));

    process.env.DATABASE_URL = 'postgresql://canvas:super-secret@postgres:5432/canvas_notebook';
    process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'true';
    process.env.CANVAS_POSTGRES_IMAGE = 'pgvector/postgres:18';
    process.env.CANVAS_POSTGRES_DATA_VOLUME = 'canvas-postgres-data';
    gate = resolveDatabaseProviderGate({
      teamFeaturesEnabled: true,
      requirePgvector: true,
      postgresRuntimeAdapterAvailable: true,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.runtimeAdapter, 'postgres');
    assert.equal(gate.config.postgres.databaseUrlConfigured, true);
    assert.equal(gate.config.postgres.databaseUrlProtocol, 'postgresql');
    assert.equal(gate.config.postgres.pgvectorEnabled, true);
    assert.equal(gate.config.vectorProvider, 'pgvector');
    assert.equal(gate.config.postgres.imageConfigured, true);
    assert.equal(gate.config.postgres.dataVolumeConfigured, true);

    const publicStatus = toPublicDatabaseProviderStatus(gate);
    const serializedStatus = JSON.stringify(publicStatus);
    assert.equal(serializedStatus.includes('super-secret'), false);
    assert.equal(serializedStatus.includes('canvas:super-secret'), false);
    assert.equal(serializedStatus.includes('postgres:5432'), false);
    assert.equal(publicStatus.postgres.databaseUrlConfigured, true);
    assert.equal(publicStatus.postgres.databaseUrlProtocol, 'postgresql');
    assert.equal(publicStatus.vectorProvider, 'pgvector');
    assert.equal(publicStatus.runtimeAdapter, 'postgres');

    process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'false';
    process.env.CANVAS_VECTOR_PROVIDER = 'none';
    gate = resolveDatabaseProviderGate({
      runtimeMode: 'personal',
      teamFeaturesEnabled: false,
      postgresRuntimeAdapterAvailable: true,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.provider, 'postgres');
    assert.equal(gate.config.vectorProvider, 'none');

    process.env.CANVAS_VECTOR_PROVIDER = 'pgvector';
    gate = resolveDatabaseProviderGate({
      teamFeaturesEnabled: true,
      requirePgvector: true,
      postgresRuntimeAdapterAvailable: true,
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((problem) => problem.code === 'pgvector_required'));

    console.log('database-provider-abstraction-test: ok');
  } finally {
    restoreEnv(snapshot);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
