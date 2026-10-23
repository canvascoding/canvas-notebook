/** Private restart fixture reader. No host, admission, migration or lifecycle mutation. */
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { requireOwnedYjsQaTarget } from './lib/owned-yjs-authority-qa';
import type { OwnedRestartRoomInput } from './lib/owned-yjs-restart-room-read';

export async function readOwnedRestartRoom(input: OwnedRestartRoomInput) {
  await requireOwnedYjsQaTarget();
  const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
  const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  try {
    await database.connect(); await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await readOwnedRestartRoomOnConnection(database, input);
  } finally { await database.end(); }
}

if (process.argv[1]?.endsWith('/owned-yjs-restart-room-read.ts')) {
  void (async () => {
    assert.equal(process.argv.length, 3); assert(process.argv[2].length <= 8 * 1024);
    const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString()) as OwnedRestartRoomInput;
    process.stdout.write(JSON.stringify(await readOwnedRestartRoom(input)));
  })().catch(() => { console.error('Owned restart room evidence remained unavailable.'); process.exitCode = 1; });
}
