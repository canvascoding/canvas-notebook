import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-build-db-isolation-'));
  const previous = {
    data: process.env.DATA,
    nextPhase: process.env.NEXT_PHASE,
    provider: process.env.CANVAS_DATABASE_PROVIDER,
    databaseUrl: process.env.DATABASE_URL,
  };

  process.env.DATA = dataRoot;
  process.env.NEXT_PHASE = 'phase-production-build';
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  delete process.env.DATABASE_URL;

  try {
    const database = await import('../app/lib/db');
    await database.ensureDatabaseReady();
    assert.equal(database.getDatabaseProvider(), 'sqlite');
    assert.equal(existsSync(path.join(dataRoot, 'sqlite.db')), false);
  } finally {
    if (previous.data === undefined) delete process.env.DATA;
    else process.env.DATA = previous.data;
    if (previous.nextPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previous.nextPhase;
    if (previous.provider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previous.provider;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }

  console.log('build database isolation tests passed');
}

void main();
