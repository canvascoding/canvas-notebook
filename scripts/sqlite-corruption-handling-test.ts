import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-sqlite-corrupt-'));
  const snapshot = {
    DATA: process.env.DATA,
    CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
    NEXT_PHASE: process.env.NEXT_PHASE,
  };

  try {
    process.env.DATA = dataRoot;
    delete process.env.CANVAS_DATABASE_PROVIDER;
    delete process.env.NEXT_PHASE;

    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'sqlite.db'), 'not a sqlite database');

    const dbModule = await import('../app/lib/db');
    const initializationError = dbModule.getDatabaseInitializationError();

    assert.ok(initializationError, 'corrupt SQLite must be captured as initialization error');
    assert.equal(initializationError.code, 'sqlite_unreadable');
    assert.match(initializationError.message, /SQLite database/u);
    assert.throws(() => dbModule.assertDatabaseAvailable(), /SQLite database/u);
    await assert.rejects(() => dbModule.openDb(), /SQLite database/u);
    assert.throws(() => dbModule.db.select(), /SQLite database/u);

    const authModule = await import('../app/lib/auth');
    assert.ok(authModule.auth, 'auth module must remain importable when SQLite is corrupt');

    const { hasAnyAuthUser } = await import('../app/lib/auth-setup');
    const { isDatabaseUnavailableError } = await import('../app/lib/db/errors');
    await assert.rejects(
      () => hasAnyAuthUser(),
      (error) => isDatabaseUnavailableError(error) && error.code === 'sqlite_unreadable',
      'auth setup checks must classify unreadable SQLite databases',
    );

    const { jsonDatabaseUnavailable } = await import('../app/lib/api/route-helpers');
    const response = jsonDatabaseUnavailable(initializationError);
    assert.ok(response, 'database unavailable errors must produce a route response');
    assert.equal(response.status, 503);
    const body = await response.json() as { success: boolean; code: string; databaseProvider: string };
    assert.equal(body.success, false);
    assert.equal(body.code, 'DATABASE_UNAVAILABLE');
    assert.equal(body.databaseProvider, 'sqlite');

    const healthModule = await import('../app/api/health/route');
    const healthResponse = await healthModule.GET();
    assert.equal(healthResponse.status, 503);
    const healthBody = await healthResponse.json() as {
      status: string;
      checks: { db?: string };
    };
    assert.equal(healthBody.status, 'unhealthy');
    assert.equal(healthBody.checks.db, 'error');

    console.log('sqlite-corruption-handling-test: ok');
  } finally {
    if (snapshot.DATA === undefined) delete process.env.DATA;
    else process.env.DATA = snapshot.DATA;
    if (snapshot.CANVAS_DATABASE_PROVIDER === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = snapshot.CANVAS_DATABASE_PROVIDER;
    if (snapshot.NEXT_PHASE === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = snapshot.NEXT_PHASE;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
