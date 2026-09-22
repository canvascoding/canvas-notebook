import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { runPostgresMigrations } from '../app/lib/db/postgres';

async function main() {
  const database = await createPiTestDatabase();
  const moduleLoader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) => request === '@/app/lib/db' ? database : originalLoad(request, parent, isMain);
  try {
    const { withMessageDeliveryReceipt, MessageDeliveryError } = await import('../app/lib/pi/message-delivery-receipt');
    const { piSessions, piMessages, piMessageDeliveryReceipts, user } = await import('../app/lib/db/schema');
    const { projectAgentMessageForPersistence } = await import('../app/lib/pi/visual-data-projection');
    const { db } = database;
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@test.invalid', emailVerified: true, createdAt: now, updatedAt: now });
    const [session] = await db.insert(piSessions).values({ sessionId: 'receipt-session', userId: 'owner', provider: 'test', model: 'test', createdAt: now, updatedAt: now }).returning();
    let dispatched = 0;
    const status = { phase: 'running' };
    const runtime = { getStatus: () => status };
    const input = {
      sessionId: session.sessionId, userId: 'owner', runtime,
      message: { role: 'user' as const, content: 'First prompt', timestamp: 123, clientMessageId: 'stable-message' },
      context: { document: { path: 'doc.md', selection: 'original' } },
      dispatch: () => { dispatched++; return status; },
    };
    assert.equal(await withMessageDeliveryReceipt(input), status);
    const retriedMessage = { ...input.message, timestamp: 999 };
    assert.equal(await withMessageDeliveryReceipt({ ...input, message: retriedMessage }), status);
    assert.equal(dispatched, 1);
    await assert.rejects(withMessageDeliveryReceipt({ ...input, message: { ...input.message, content: 'changed' } }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_ID_CONFLICT');
    await assert.rejects(withMessageDeliveryReceipt({ ...input, context: { document: { path: 'other.md' } } }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_ID_CONFLICT');
    await assert.rejects(withMessageDeliveryReceipt({ ...input, mode: 'steer' }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_ID_CONFLICT');
    await assert.rejects(withMessageDeliveryReceipt({ ...input, message: { ...input.message, clientMessageId: '' } }), error => error instanceof MessageDeliveryError && error.code === 'INVALID_CLIENT_MESSAGE_ID');

    const replacement = { getStatus: () => ({ phase: 'idle' }) };
    await assert.rejects(withMessageDeliveryReceipt({ ...input, runtime: replacement }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_DELIVERY_UNCERTAIN');
    assert.equal(dispatched, 1);
    // Use the real projection that session-store persists, including clientMessageId.
    const projected = projectAgentMessageForPersistence(input.message);
    await db.insert(piMessages).values({ piSessionDbId: session.id, role: 'user', content: JSON.stringify(projected), timestamp: 123, sequence: 1 });
    assert.deepEqual(await withMessageDeliveryReceipt({ ...input, runtime: replacement }), { phase: 'idle' });
    assert.equal(dispatched, 1);
    const oldMobileMessage = { ...input.message, clientMessageId: 'pre-receipt-mobile-message' };
    await db.insert(piMessages).values({ piSessionDbId: session.id, role: 'user', content: JSON.stringify(projectAgentMessageForPersistence(oldMobileMessage)), timestamp: 124, sequence: 2 });
    await assert.rejects(withMessageDeliveryReceipt({ ...input, message: oldMobileMessage }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_DELIVERY_UNCERTAIN');
    await assert.rejects(withMessageDeliveryReceipt({ ...input, message: oldMobileMessage }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_DELIVERY_UNCERTAIN');
    assert.equal(dispatched, 1);

    // Simultaneous claims from independent runtime instances cannot both dispatch.
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const concurrent = { ...input, message: { ...input.message, clientMessageId: 'concurrent' }, dispatch: async () => { dispatched++; entered(); await pending; return status; } };
    const first = withMessageDeliveryReceipt(concurrent);
    await started;
    await assert.rejects(withMessageDeliveryReceipt({ ...concurrent, runtime: replacement }), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_DELIVERY_UNCERTAIN');
    release();
    await first;
    assert.equal(dispatched, 2);

    // Dispatch succeeded, but updating the receipt failed: same-runtime retry is safe.
    await database.getPostgresRuntimeQueryable().exec(`
      CREATE FUNCTION fail_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt update failure'; END $$;
      CREATE TRIGGER fail_receipt_update BEFORE UPDATE ON pi_message_delivery_receipts FOR EACH ROW EXECUTE FUNCTION fail_receipt_update();
    `);
    const uncertainWrite = { ...input, message: { ...input.message, clientMessageId: 'update-failed' } };
    await assert.rejects(withMessageDeliveryReceipt(uncertainWrite), /injected receipt update failure|Failed query/);
    assert.equal(dispatched, 3);
    assert.equal(await withMessageDeliveryReceipt(uncertainWrite), status);
    assert.equal(dispatched, 3);
    await database.getPostgresRuntimeQueryable().exec('DROP TRIGGER fail_receipt_update ON pi_message_delivery_receipts; DROP FUNCTION fail_receipt_update();');
    const failedDispatch = { ...input, message: { ...input.message, clientMessageId: 'dispatch-failed' }, dispatch: () => { throw new Error('Partial dispatch failure'); } };
    await assert.rejects(withMessageDeliveryReceipt(failedDispatch), /Partial dispatch failure/);
    await assert.rejects(withMessageDeliveryReceipt(failedDispatch), error => error instanceof MessageDeliveryError && error.code === 'MESSAGE_DELIVERY_UNCERTAIN');

    // Startup migration is additive and repeatable; receipts survive another startup.
    await runPostgresMigrations(database.getPostgresRuntimeQueryable() as never);
    assert.equal((await db.select().from(piMessageDeliveryReceipts)).length, 4);
    await db.delete(piMessages).where(eq(piMessages.piSessionDbId, session.id));
    await db.delete(piSessions).where(eq(piSessions.id, session.id));
    assert.equal((await db.select().from(piMessageDeliveryReceipts)).length, 0);
    console.log('Message delivery receipts: replay, conflicts, races, persistence, uncertainty, migration and cascade passed.');
  } finally {
    moduleLoader._load = originalLoad;
    await database.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
