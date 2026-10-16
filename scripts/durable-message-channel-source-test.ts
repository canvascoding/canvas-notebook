import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { piMessageDeliveryReceipts } from '../app/lib/db/schema';
import { runChatMessageTelegramSourceMigration, TELEGRAM_MESSAGE_SOURCE_UNIQUE_INDEX } from '../app/lib/db/chat-message-telegram-source-migration';
import type { SqlConnection } from '../app/lib/db';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

/** Genuine application SQL, admitted payloads, sessions, grants and historical
 * channel-state writer. No authority, Runtime registry or provider is mocked.
 * SQL transport hooks inject only a real committed source/ACL change between
 * reads. No message is attached to an SDK queue or sent to a model.
 */
async function main(): Promise<void> {
  assert.equal(process.argv.includes('--native'), false, 'This focused source-reader suite is PGlite-only.');
  const fixture = await createDurableMessageExecutionFixture();
  const application = fixture.application;
  const nonce = randomUUID().replaceAll('-', '');
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await application.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  let stage = 'genuine channel sessions and acceptance';
  try {
    const admission = await import('../app/lib/pi/durable-message-admission');
    const { activateOwnedChannelSessionState } = await import('../app/lib/channels/channel-session-store');
    const { ensureSessionChannelLink } = await import('../app/lib/channels/channel-links');
    const first = await fixture.createSessionRuntime({ userId: 'alice' });
    const second = await fixture.createSessionRuntime({ userId: 'alice', agentId: first.agentId });
    const foreign = await fixture.createSessionRuntime({ userId: 'bob', agentId: first.agentId });
    const channelSessionKey = `telegram:${nonce}`;
    const source = { userId: 'alice', channelId: 'telegram' as const, channelSessionKey, clientMessageId: `telegram:${nonce}:message-1` };
    const channel = { userId: 'alice', agentId: first.agentId, channelId: 'telegram', channelSessionKey };
    const uncertain = { code: 'MESSAGE_DELIVERY_UNCERTAIN', statusCode: 409 };
    const activate = async (sessionId: string) => {
      assert.equal(await activateOwnedChannelSessionState({ ...channel, sessionId }), sessionId);
    };
    const accept = async (frame: typeof first, id: string, channelId = 'telegram') => {
      const prepared = await admission.prepareChatMessageAdmission({ userId: frame.userId, sessionId: frame.sessionId,
        clientMessageId: id, expectedAgentId: frame.agentId, expectedWorkspaceId: frame.context.workspaceId,
        message: { role: 'user', content: `Actual channel message ${id}`, timestamp: 100 }, context: { channelId } });
      assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('Expected actual new acceptance.');
      return admission.commitPreparedChatMessageAdmission(prepared.admission);
    };
    const counts = () => sql(async database => ({
      sessions: (await database.all('SELECT id FROM pi_sessions')).length,
      receipts: (await database.all('SELECT pi_session_db_id,client_message_id FROM pi_message_delivery_receipts')).length,
      transcripts: (await database.all('SELECT id FROM pi_messages')).length,
    }));
    await activate(first.sessionId);
    const accepted = await accept(first, source.clientMessageId), expected = admission.readOwnedChatMessageExecutionSnapshot(accepted);
    await activate(second.sessionId);
    const historical = await sql(database => database.get(`SELECT is_primary FROM session_channel_links
      WHERE user_id='alice' AND session_id=$1 AND channel_id='telegram' AND channel_session_key=$2 AND channel_thread_key=''`,
    [first.sessionId, channelSessionKey])) as { is_primary: boolean };
    assert.equal(Boolean(historical.is_primary), false, 'The former active session retains its actual historical link.');
    const active = () => sql(database => database.get(`SELECT session_id FROM channel_active_sessions
      WHERE user_id='alice' AND agent_id=$1 AND channel_id='telegram' AND channel_session_key=$2 AND channel_thread_key=''`,
    [first.agentId, channelSessionKey])) as Promise<{ session_id: string }>;
    assert.equal((await active()).session_id, second.sessionId);
    const beforeRead = await counts(), metadataCounts = fixture.counts();

    stage = 'historical nonprimary link locates the exact original SQL row without source probes';
    let sourceReads = 0;
    application.setBeforeRead(async query => {
      if (/\b(?:agent_capability_bindings|agent_user_preferences|capability_resources|integration_connections)\b/iu.test(query)) {
        sourceReads++; throw new Error('The channel reader must not prepare package/provider metadata.');
      }
    });
    try {
      const recovered = await admission.readOwnedAcceptedChatMessageForChannelSource(source); assert(recovered);
      const actual = admission.readOwnedChatMessageExecutionSnapshot(recovered);
      assert.equal(actual.payload.serverMessageId, expected.payload.serverMessageId);
      assert.equal(actual.payload.identity.sessionId, first.sessionId); assert.equal(actual.sessionDbId, expected.sessionDbId);
      assert.equal(actual.phase, 'queued'); assert.equal(actual.executionRevision, 1);
      assert.equal(actual.payload.context.channelId, 'telegram'); assert.equal(sourceReads, 0);
    } finally { application.setBeforeRead(undefined); }
    assert.equal((await active()).session_id, second.sessionId); assert.deepEqual(await counts(), beforeRead);
    assert.deepEqual(fixture.counts(), metadataCounts);

    stage = 'exact user/key/thread and descriptor-safe source capture';
    assert.equal(await admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, channelSessionKey: 'telegram:other' }), null);
    assert.equal(await admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, channelThreadKey: 'other' }), null);
    assert.equal(await admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, userId: 'bob' }), null);
    let getterCalls = 0, invalidReads = 0;
    application.setBeforeRead(async () => { invalidReads++; });
    const getter = Object.defineProperty({ ...source }, 'clientMessageId', { enumerable: true,
      get: () => { getterCalls++; return source.clientMessageId; } });
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource(getter));
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, channelId: 'web' as 'telegram' }));
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, channelThreadKey: ' padded ' }));
    assert.equal(getterCalls, 0); assert.equal(invalidReads, 0); application.setBeforeRead(undefined);
    await ensureSessionChannelLink({ userId: 'bob', sessionId: foreign.sessionId, channelId: 'telegram', channelSessionKey });
    const bobAccepted = await accept(foreign, source.clientMessageId);
    const bob = await admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, userId: 'bob' }); assert(bob);
    assert.equal(admission.readOwnedChatMessageExecutionSnapshot(bob).payload.serverMessageId,
      admission.readOwnedChatMessageExecutionSnapshot(bobAccepted).payload.serverMessageId);
    assert.notEqual(admission.readOwnedChatMessageExecutionSnapshot(bob).sessionDbId, expected.sessionDbId);

    stage = 'stored channel mismatch and legacy rows cannot fall through to a new session';
    const wrongContextId = `telegram:${nonce}:wrong-context`;
    await accept(first, wrongContextId, 'web');
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, clientMessageId: wrongContextId }), uncertain);
    const legacyId = `telegram:${nonce}:legacy`;
    await sql(database => database.run(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at)
      VALUES ($1,$2,$3,'legacy-owner','accepted',$4,$4)`, [expected.sessionDbId, legacyId, 'a'.repeat(64), Date.now()]));
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, clientMessageId: legacyId }), uncertain);

    stage = 'archived and ambiguous historical matches fail closed';
    await sql(database => database.run('UPDATE pi_sessions SET archived_at=$2 WHERE id=$1', [expected.sessionDbId, Date.now()]));
    try { await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource(source), uncertain); }
    finally { await sql(database => database.run('UPDATE pi_sessions SET archived_at=NULL WHERE id=$1', [expected.sessionDbId])); }
    const duplicateId = `telegram:${nonce}:duplicate`;
    await accept(first, duplicateId); await accept(second, duplicateId);
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, clientMessageId: duplicateId }), uncertain);

    stage = 'actual current Agent Use revocation cannot produce an owned handle';
    await sql(database => database.run(`UPDATE agent_grants SET can_use=0
      WHERE agent_id=$1 AND target_type='user' AND target_id='alice'`, [first.agentId]));
    try { await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource(source)); }
    finally { await sql(database => database.run(`UPDATE agent_grants SET can_use=1
      WHERE agent_id=$1 AND target_type='user' AND target_id='alice'`, [first.agentId])); }

    stage = 'a committed historical-link change during the read is detected before return';
    let changed = false;
    application.setAfterRead(async query => {
      if (changed || !query.includes('JOIN session_channel_links l')) return;
      changed = true; application.setAfterRead(undefined);
      await sql(database => database.run(`DELETE FROM session_channel_links
        WHERE user_id='alice' AND session_id=$1 AND channel_id='telegram' AND channel_session_key=$2 AND channel_thread_key=''`,
      [first.sessionId, channelSessionKey]));
    });
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource(source), uncertain);
    assert.equal(changed, true); application.setAfterRead(undefined);
    await ensureSessionChannelLink({ ...channel, sessionId: first.sessionId, isPrimary: false });
    assert(await admission.readOwnedAcceptedChatMessageForChannelSource(source));
    assert.equal((await active()).session_id, second.sessionId);
    assert.equal((await counts()).transcripts, 0); assert.equal(fixture.counts().forbiddenModelRequests, 0);
    assert.equal(fixture.counts().externalRequests, 0);
    stage = 'fresh/schema/repeated migration enforces source IDs per user across physical sessions';
    assert(getTableConfig(piMessageDeliveryReceipts).indexes.some(index => index.config.name === TELEGRAM_MESSAGE_SOURCE_UNIQUE_INDEX
      && index.config.unique && index.config.where));
    const migration = () => runChatMessageTelegramSourceMigration({ query: statement => sql(database => database.all(statement)) });
    await migration(); await migration();
    const index = await sql(database => database.get(`SELECT indexdef FROM pg_indexes
      WHERE tablename='pi_message_delivery_receipts' AND indexname=$1`, [TELEGRAM_MESSAGE_SOURCE_UNIQUE_INDEX])) as { indexdef: string };
    assert(index?.indexdef.includes('UNIQUE INDEX')); assert(index.indexdef.includes('userId')); assert(index.indexdef.includes('telegram:'));
    const sourceId = `telegram:${createHash('sha256').update(nonce).digest('hex')}`;
    const originalSource = await accept(first, sourceId);
    const secondBefore = await counts();
    const secondCounterBefore = await sql(database => database.get('SELECT message_queue_ordinal FROM pi_sessions WHERE user_id=$1 AND session_id=$2',
      ['alice', second.sessionId]));
    await assert.rejects(accept(second, sourceId), uncertain);
    assert.deepEqual(await counts(), secondBefore, 'A losing cross-session admission never inserts or rewrites a receipt.');
    assert.deepEqual(await sql(database => database.get('SELECT message_queue_ordinal FROM pi_sessions WHERE user_id=$1 AND session_id=$2',
      ['alice', second.sessionId])), secondCounterBefore, 'The rejected admission rolls back its ordinal allocation.');
    const otherUserSource = await accept(foreign, sourceId);
    assert.notEqual(admission.readOwnedChatMessageExecutionSnapshot(otherUserSource).payload.identity.userId,
      admission.readOwnedChatMessageExecutionSnapshot(originalSource).payload.identity.userId);
    const originalRecovered = await admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, clientMessageId: sourceId }); assert(originalRecovered);
    assert.equal(admission.readOwnedChatMessageExecutionSnapshot(originalRecovered).payload.identity.sessionId, first.sessionId);
    // Existing ordinary IDs remain session-local (the earlier duplicateId was
    // admitted in both sessions), and hash-only V1 legacy rows are not parsed.
    const legacySourceId = `telegram:${'f'.repeat(64)}`;
    const secondDbId = (await sql(database => database.get('SELECT id FROM pi_sessions WHERE user_id=$1 AND session_id=$2',
      ['alice', second.sessionId])) as { id: number }).id;
    for (const sessionDbId of [expected.sessionDbId, secondDbId]) await sql(database => database.run(`INSERT INTO pi_message_delivery_receipts
      (pi_session_db_id,client_message_id,payload_hash,runtime_token,state,created_at,updated_at)
      VALUES ($1,$2,$3,'legacy-owner','accepted',$4,$4)`, [sessionDbId, legacySourceId, 'b'.repeat(64), Date.now()]));
    await migration();
    await assert.rejects(admission.readOwnedAcceptedChatMessageForChannelSource({ ...source, clientMessageId: legacySourceId }), uncertain);

    stage = 'historical source conflicts stop migration without deleting or rewriting data';
    // Recreate the genuine pre-index historical state on this owned database.
    // The migration itself must not repair or choose between its conflicting rows.
    await sql(database => database.run(`DROP INDEX ${TELEGRAM_MESSAGE_SOURCE_UNIQUE_INDEX}`));
    await accept(second, sourceId);
    const historicalRows = await sql(database => database.all(`SELECT pi_session_db_id,client_message_id,private_payload,payload_hash
      FROM pi_message_delivery_receipts ORDER BY pi_session_db_id,client_message_id`));
    await assert.rejects(migration(), { code: '23505' });
    assert.deepEqual(await sql(database => database.all(`SELECT pi_session_db_id,client_message_id,private_payload,payload_hash
      FROM pi_message_delivery_receipts ORDER BY pi_session_db_id,client_message_id`)), historicalRows);
    console.log('PASS durable channel source: actual historical Telegram links, exact SQL ownership, no active-session retarget, actor/key/thread isolation, archive/legacy/ambiguity/revoke/source-drift fail closed; actual user-scoped source unique fence and nonrepairing migration.');
  } catch (error) {
    console.error(`FAIL durable channel source at ${stage}:`, error); throw error;
  } finally {
    application.setBeforeRead(undefined); application.setAfterRead(undefined); application.setAfterQuery(undefined);
    await fixture.close();
  }
}
void main();
