import assert from 'node:assert/strict';

async function main(): Promise<void> {
  const previous = {
    provider: process.env.CANVAS_DATABASE_PROVIDER,
    databaseUrl: process.env.DATABASE_URL,
    phase: process.env.NEXT_PHASE,
  };

  try {
    delete process.env.CANVAS_DATABASE_PROVIDER;
    delete process.env.DATABASE_URL;
    delete process.env.NEXT_PHASE;
    const provider = await import('../app/lib/db/provider');
    assert.equal(provider.getDatabaseProvider(), 'postgres');
    assert.throws(() => provider.assertRuntimeDatabaseProviderSupported(), /requires DATABASE_URL/u);

    process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
    const postgresConfig = provider.resolveDatabaseProviderConfig();
    assert.equal(postgresConfig.provider, 'postgres');
    assert.ok(postgresConfig.problems.some((problem) => problem.code === 'postgres_missing_database_url'));
    assert.throws(() => provider.assertRuntimeDatabaseProviderSupported(), /requires DATABASE_URL/u);

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://canvas:test@127.0.0.1:1/canvas';
    process.env.NEXT_PHASE = 'phase-production-build';
    const db = await import('../app/lib/db');
    assert.equal(db.getDatabaseInitializationError()?.code, 'database_initialization_failed');
  } finally {
    if (previous.provider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previous.provider;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.phase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previous.phase;
  }
  console.log('postgres-runtime-only-test: ok');
}

void main();
