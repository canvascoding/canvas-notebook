import assert from 'node:assert/strict';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../app/lib/db';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';
import { telegramInboundClientMessageId } from '../app/lib/channels/telegram/message-identity';

/** One composed cold replay: genuine Router, Service, admission, Use, SQL and
 * historical channel links. Factory entry points and network I/O are hard
 * failure boundaries only; no source/actor/owned handle is replaced or issued.
 * PGlite transport evidence, never HTTP/WebSocket/provider acceptance.
 */
async function main(): Promise<void> {
  assert.equal(process.argv.includes('--native'), false);
  const fixture = await createDurableMessageExecutionFixture();
  const application = fixture.application;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const previousLoad = loader._load, previousFetch = globalThis.fetch;
  let factoryBoundaryInstalled = false, factoryCalls = 0, networkCalls = 0;
  const sql = async <T>(operation: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await application.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  try {
    const admission = await import('../app/lib/pi/durable-message-admission');
    const { activateOwnedChannelSessionState } = await import('../app/lib/channels/channel-session-store');
    const { telegramChannelSessionKey } = await import('../app/lib/channels/constants');
    const first = await fixture.createSessionRuntime({ userId: 'alice' });
    const second = await fixture.createSessionRuntime({ userId: 'alice', agentId: first.agentId });
    const chatId = '100', channelSessionKey = telegramChannelSessionKey(chatId);
    const clientMessageId = telegramInboundClientMessageId('42', chatId, Number.parseInt(randomUUID().slice(0, 6), 16) + 1);
    const content = 'Exact original Telegram intent after active-session switch.';
    const activate = (sessionId: string) => activateOwnedChannelSessionState({ userId: 'alice', agentId: first.agentId,
      sessionId, channelId: 'telegram', channelSessionKey });
    assert.equal(await activate(first.sessionId), first.sessionId);
    const prepared = await admission.prepareChatMessageAdmission({ userId: 'alice', sessionId: first.sessionId,
      clientMessageId, expectedAgentId: first.agentId, expectedWorkspaceId: first.context.workspaceId,
      message: { role: 'user', content, timestamp: 100 }, context: { channelId: 'telegram' } });
    assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('Expected original new admission.');
    const original = await admission.commitPreparedChatMessageAdmission(prepared.admission);
    const originalSnapshot = admission.readOwnedChatMessageExecutionSnapshot(original);
    assert.equal(await activate(second.sessionId), second.sessionId);
    const primary = await sql(database => database.get(`SELECT is_primary FROM session_channel_links
      WHERE user_id='alice' AND session_id=$1 AND channel_id='telegram' AND channel_session_key=$2 AND channel_thread_key=''`,
    [first.sessionId, channelSessionKey])) as { is_primary: boolean };
    assert.equal(Boolean(primary.is_primary), false);
    assert.equal(await fixture.runtimeApi.invalidatePiRuntime(first.sessionId, 'alice'), true);
    assert.equal(await fixture.runtimeApi.invalidatePiRuntime(second.sessionId, 'alice'), true);
    assert.equal(await fixture.runtimeApi.getExistingPiRuntime(first.sessionId, 'alice'), null);
    assert.equal(await fixture.runtimeApi.getExistingPiRuntime(second.sessionId, 'alice'), null);

    const snapshot = async () => sql(async database => {
      const result: Record<string, unknown> = {};
      for (const table of ['channel_active_sessions', 'session_channel_links', 'pi_message_delivery_receipts', 'pi_messages', 'pi_sessions']) {
        const rows = await database.all(`SELECT * FROM ${table}`);
        result[table] = rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      }
      return result;
    });
    const before = await snapshot(), requestsBefore = fixture.counts();
    const failFactory = (): never => { factoryCalls++; throw new Error('Cold replay attempted to create a Runtime.'); };
    loader._load = (name, parent, isMain) => {
      const actual = previousLoad(name, parent, isMain);
      if (parent?.filename.endsWith('/pi/runtime-service.ts') && (name === '@/app/lib/pi/live-runtime'
        || name.endsWith('/app/lib/pi/live-runtime.ts'))) {
        factoryBoundaryInstalled = true;
        return { ...(actual as object), getOrCreatePiRuntime: failFactory, getOrCreatePiRuntimeWithState: failFactory };
      }
      return actual;
    };
    globalThis.fetch = async () => { networkCalls++; throw new Error('Cold replay attempted network/provider I/O.'); };
    application.setBeforeRead(async query => {
      if (/\b(?:agent_capability_bindings|agent_user_preferences|capability_resources|integration_connections)\b/iu.test(query)) {
        throw new Error('Cold replay attempted source/provider preparation.');
      }
    });
    const { handleInboundChannelMessage } = await import('../app/lib/channels/router');
    assert.equal(factoryBoundaryInstalled, true, 'The actual Service must import the guarded factory boundary.');
    const result = await handleInboundChannelMessage({ channelId: 'telegram', channelSessionKey, userId: 'alice',
      clientMessageId, agentMessageTimestamp: 999, text: content });
    assert.deepEqual(result, { sessionId: first.sessionId, status: null });
    assert.equal(factoryCalls, 0); assert.equal(networkCalls, 0);
    application.setBeforeRead(undefined);
    assert.deepEqual(await snapshot(), before, 'Replay changes neither active session, links, receipt/queue metadata, transcript nor session.');
    assert.deepEqual(fixture.counts(), requestsBefore);
    const reread = await admission.readOwnedAcceptedChatMessage({ userId: 'alice', sessionId: first.sessionId, clientMessageId,
      expectedAgentId: first.agentId, expectedWorkspaceId: first.context.workspaceId }); assert(reread);
    assert.deepEqual(admission.readOwnedChatMessageExecutionSnapshot(reread), originalSnapshot);
    assert.equal(await fixture.runtimeApi.getExistingPiRuntime(first.sessionId, 'alice'), null);
    assert.equal(await fixture.runtimeApi.getExistingPiRuntime(second.sessionId, 'alice'), null);
    console.log('PASS actual Router→Service→SQL cold Telegram replay after active-session switch: original physical receipt, current Use, no Runtime/source/provider start and unchanged active/link/receipt/transcript/session SQL.');
  } finally {
    application.setBeforeRead(undefined);
    loader._load = previousLoad; globalThis.fetch = previousFetch;
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
