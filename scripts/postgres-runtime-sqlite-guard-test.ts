import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-postgres-no-sqlite-'));
  const previous = {
    data: process.env.DATA,
    provider: process.env.CANVAS_DATABASE_PROVIDER,
    databaseUrl: process.env.DATABASE_URL,
  };

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://canvas:canvas@127.0.0.1:1/canvas';

  try {
    const { openOrganizationBootstrapDatabase } = await import('../app/lib/organization/bootstrap');
    assert.throws(
      () => openOrganizationBootstrapDatabase(),
      /Postgres runtime cannot open the organization bootstrap database through SQLite/u,
    );
    assert.equal(existsSync(path.join(dataRoot, 'sqlite.db')), false);
  } finally {
    if (previous.data === undefined) delete process.env.DATA;
    else process.env.DATA = previous.data;
    if (previous.provider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previous.provider;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }

  console.log('postgres runtime SQLite guard tests passed');
}

void main();
