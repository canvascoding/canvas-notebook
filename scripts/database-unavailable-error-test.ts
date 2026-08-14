import assert from 'node:assert/strict';

type EnvSnapshot = {
  CANVAS_DATABASE_PROVIDER?: string;
  DATABASE_URL?: string;
};

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function databaseError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function main(): Promise<void> {
  const snapshot: EnvSnapshot = {
    CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  try {
    const {
      coerceDatabaseUnavailableError,
      isDatabaseUnavailableError,
    } = await import('../app/lib/db/errors');

    const sqliteError = coerceDatabaseUnavailableError(
      databaseError('file is not a database', 'SQLITE_NOTADB'),
      { provider: 'sqlite', sqlitePath: '/tmp/canvas.sqlite.db' },
    );
    assert.equal(sqliteError?.code, 'sqlite_unreadable');

    const postgresError = coerceDatabaseUnavailableError(
      databaseError('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'),
      { provider: 'postgres' },
    );
    assert.equal(postgresError?.code, 'postgres_unavailable');

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://canvas@127.0.0.1:1/canvas';

    const database = await import('../app/lib/db');
    await assert.rejects(
      () => database.openDb(),
      (error) => isDatabaseUnavailableError(error) && error.code === 'postgres_unavailable',
      'Postgres connection failures must use the same unavailable-database contract as SQLite.',
    );
    await database.closeDatabaseConnections();

    const { jsonDatabaseUnavailable } = await import('../app/lib/api/route-helpers');
    const response = jsonDatabaseUnavailable(postgresError);
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'The PostgreSQL database is unavailable. Check its connection and credentials, then retry.',
      code: 'DATABASE_UNAVAILABLE',
      databaseProvider: 'postgres',
    });

    console.log('database-unavailable-error-test: ok');
  } finally {
    restoreEnv(snapshot);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
