import assert from 'node:assert/strict';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { piMetadataFixture, piToolMetadataFixture } from './helpers/pi-message-fixture';
import * as schema from '../app/lib/db/schema';
import {
  startPiSessionCompactionAttemptOnConnection,
  commitPiSessionCompactionSummaryOnConnection,
  PiCompactionScopeError,
} from '../app/lib/pi/session-compaction-store';

async function main() {
  const database = await createPiTestDatabase();
  try {
    const now = new Date();
    const scope = { sessionId: 'compaction-store', userId: 'compaction-user', agentId: 'bradley', workspaceId: 'compaction-workspace' };
    await database.db.insert(schema.user).values({ id: scope.userId, email: 'compaction@example.test', emailVerified: true, name: 'Fixture', createdAt: now, updatedAt: now });
    const [session] = await database.db.insert(schema.piSessions).values({
      ...scope, provider: 'openai', model: 'fixture-model', title: 'Fixture',
      createdAt: now, updatedAt: now,
    }).returning({ id: schema.piSessions.id });
    const messages = [
      { role: 'user', content: 'Inspect', timestamp: 999 }, piMetadataFixture, piToolMetadataFixture,
      { ...piMetadataFixture, content: [{ type: 'text', text: 'Done' }], stopReason: 'stop', endTurn: true, timestamp: 1_002 },
    ];
    const rows = messages.map((message, index) => ({
      piSessionDbId: session.id, role: message.role, content: JSON.stringify(message), timestamp: message.timestamp, sequence: index + 1,
    }));
    await database.db.insert(schema.piMessages).values(rows);
    const connection = await database.openDb();
    const start = {
      ...scope, attemptId: 'attempt-1', trigger: 'manual' as const, provider: 'openai', model: 'fixture-model',
      expectedSummaryRevision: 0, expectedThroughSequence: null, now, deadlineAt: new Date(now.getTime() + 60_000),
    };
    const attempt = await startPiSessionCompactionAttemptOnConnection(connection, start);
    assert.equal(attempt.status, 'started');
    assert.equal((await startPiSessionCompactionAttemptOnConnection(connection, { ...start, attemptId: 'concurrent-attempt' })).status, 'already_running');
    const commit = { ...scope, attemptId: 'attempt-1', expectedSummaryRevision: 0, expectedThroughSequence: null, summaryText: 'Inspected the fixture.', throughSequence: 4, now };
    const saved = await commitPiSessionCompactionSummaryOnConnection(connection, commit);
    assert.equal(saved.status, 'committed');
    if (saved.status === 'committed') assert.equal(saved.summary.summaryRevision, 1);
    assert.equal((await commitPiSessionCompactionSummaryOnConnection(connection, commit)).status, 'already_finished');
    assert.equal((await startPiSessionCompactionAttemptOnConnection(connection, { ...start, attemptId: 'stale-attempt' })).status, 'stale');
    await assert.rejects(startPiSessionCompactionAttemptOnConnection(connection, { ...start, userId: 'another-user' }), PiCompactionScopeError);
    const retained = await database.db.select().from(schema.piMessages);
    assert.deepEqual(retained.sort((left, right) => left.sequence! - right.sequence!).map((row) => row.content), rows.map((row) => row.content), 'compaction commits must not rewrite original signature/metadata bytes');
    console.log('Pi PostgreSQL compaction durability and metadata contracts passed');
  } finally { await database.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
