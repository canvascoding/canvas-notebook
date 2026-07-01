import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type EnvSnapshot = {
  DATA?: string;
  CANVAS_DATABASE_PROVIDER?: string;
  CANVAS_POSTGRES_VECTOR_ENABLED?: string;
  CANVAS_POSTGRES_IMAGE?: string;
  CANVAS_POSTGRES_DATA_VOLUME?: string;
  DATABASE_URL?: string;
};

function snapshotEnv(): EnvSnapshot {
  return {
    DATA: process.env.DATA,
    CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
    CANVAS_POSTGRES_VECTOR_ENABLED: process.env.CANVAS_POSTGRES_VECTOR_ENABLED,
    CANVAS_POSTGRES_IMAGE: process.env.CANVAS_POSTGRES_IMAGE,
    CANVAS_POSTGRES_DATA_VOLUME: process.env.CANVAS_POSTGRES_DATA_VOLUME,
    DATABASE_URL: process.env.DATABASE_URL,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of Object.keys(snapshot) as Array<keyof EnvSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function resetProviderEnv(dataDir: string): void {
  process.env.DATA = dataDir;
  delete process.env.CANVAS_DATABASE_PROVIDER;
  delete process.env.CANVAS_POSTGRES_VECTOR_ENABLED;
  delete process.env.CANVAS_POSTGRES_IMAGE;
  delete process.env.CANVAS_POSTGRES_DATA_VOLUME;
  delete process.env.DATABASE_URL;
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

    assert.equal(getDatabaseProvider(), 'sqlite');
    assert.equal(resolveSqlitePath(), path.join(dataDir, 'sqlite.db'));
    let config = resolveDatabaseProviderConfig();
    assert.equal(config.provider, 'sqlite');
    assert.equal(config.runtimeAdapter, 'sqlite');
    assert.deepEqual(config.problems, []);

    let gate = resolveDatabaseProviderGate({ teamFeaturesEnabled: false });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.blockers, []);
    assert.doesNotThrow(() => assertRuntimeDatabaseProviderSupported());

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
    assert.equal(gate.config.postgres.imageConfigured, true);
    assert.equal(gate.config.postgres.dataVolumeConfigured, true);

    const publicStatus = toPublicDatabaseProviderStatus(gate);
    const serializedStatus = JSON.stringify(publicStatus);
    assert.equal(serializedStatus.includes('super-secret'), false);
    assert.equal(serializedStatus.includes('canvas:super-secret'), false);
    assert.equal(serializedStatus.includes('postgres:5432'), false);
    assert.equal(publicStatus.postgres.databaseUrlConfigured, true);
    assert.equal(publicStatus.postgres.databaseUrlProtocol, 'postgresql');
    assert.equal(publicStatus.runtimeAdapter, 'postgres');

    process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'false';
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
