import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { closeDatabaseConnections, openDb } from '../app/lib/db';
import { lockIdentity } from '../app/lib/collaboration/room-owner';

async function main() {
  assert.equal(process.env.COLLABORATION_E2E, '1');
  assert.equal(process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST, '1');
  const url = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/canvas_notebook');
  const input = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8')) as {
    documentId: string;
    workspaceId: string;
    path: string;
  };
  assert.match(input.documentId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.match(input.workspaceId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.match(input.path, /^fvrc-1008-ordinary-[a-f0-9-]{36}\.md$/u);
  const lock = lockIdentity(input.documentId);
  try {
    const database = await openDb();
    try {
      const row = await database.get(`SELECT room_owner_epoch, room_owner_token, room_owner_backend_pid,
        room_owner_backend_start FROM collaboration_yjs_states
        WHERE document_id = $1 AND workspace_id = $2 AND path = $3 AND status = 'active'`,
      [input.documentId, input.workspaceId, input.path]) as Record<string, unknown> | undefined;
      assert(row);
      const activities = await database.all(`SELECT pid, application_name,
        extract(epoch FROM backend_start)::text AS backend_start
        FROM pg_stat_activity WHERE datname = current_database()
          AND application_name LIKE 'canvas-collaboration-owner-test-%'
        ORDER BY application_name`, []) as Array<Record<string, unknown>>;
      const holder = row.room_owner_backend_pid === null ? null : await database.get(`SELECT EXISTS (
        SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock'
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid::bigint = $1 AND l.objid::bigint = $2 AND l.objsubid = 1
          AND l.pid = $3 AND extract(epoch FROM a.backend_start)::text = $4
      ) AS held`, [lock.high, lock.low, row.room_owner_backend_pid, row.room_owner_backend_start]) as { held: boolean } | undefined;
      process.stdout.write(JSON.stringify({
        epoch: Number(row.room_owner_epoch),
        tokenHash: typeof row.room_owner_token === 'string'
          ? createHash('sha256').update(row.room_owner_token).digest('hex') : null,
        backendPid: row.room_owner_backend_pid === null ? null : Number(row.room_owner_backend_pid),
        backendStart: row.room_owner_backend_start,
        lockHeld: holder?.held === true,
        activities: activities.map(activity => ({
          pid: Number(activity.pid),
          applicationName: String(activity.application_name),
          backendStart: String(activity.backend_start),
        })),
      }));
    } finally { await database.close(); }
  } finally { await closeDatabaseConnections(); }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Multi-process owner evidence read failed.');
  process.exitCode = 1;
});
