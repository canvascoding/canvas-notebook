import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createPiTestDatabase } from './helpers/pi-test-database';

const model: Model<'openai-completions'> = {
  id: 'delegation-steering-integration-test',
  name: 'Delegation Steering Integration Test',
  api: 'openai-completions',
  provider: 'test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 2_048,
};

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function completedStream(message: AssistantMessage): Awaited<ReturnType<StreamFn>> {
  return {
    async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; },
    result: async () => message,
  } as unknown as Awaited<ReturnType<StreamFn>>;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-delegation-steering-'));
  process.env.DATA = root;
  process.env.CANVAS_DATA_ROOT = root;
  const database = await createPiTestDatabase();
  const modules = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = modules._load;
  modules._load = (request, parent, isMain) => {
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
    if (request === 'server-only') return {};
    if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
    if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    }
    if (request === '@/app/lib/agents/access') return { requireAgentAccess: async () => undefined };
    if (request === '@/app/lib/agents/workspace-file-tree-context') return {
      buildWorkspaceFileTreePrompt: async () => ({ promptBlock: 'workspace tree' }),
      replaceWorkspaceFileTreePromptBlock: () => 'worker system instructions',
    };
    return originalLoad(request, parent, isMain);
  };

  try {
    const { db } = database;
    const { piDelegations, piDelegationSteering, piMessages, piSessions, user } = await import('../app/lib/db/schema');
    const { runEphemeralWorker } = await import('../app/lib/pi/delegate-task-tool');
    const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
    const { savePiSession } = await import('../app/lib/pi/session-store');
    const { completeRunningPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { acceptPiDelegationSteering, markUndeliveredPiDelegationSteeringMissed } = await import('../app/lib/pi/delegation-steering');

    const now = new Date();
    const userId = 'steering-owner';
    const parentId = 'steering-parent';
    const childId = 'steering-child';
    const delegationId = 'steering-task';
    const runOwnerId = 'steering-worker-owner';
    const correctionText = 'Also inspect the second file.';
    const promptMessage = { role: 'user' as const, content: 'Inspect two files.', timestamp: now.getTime() };
    await db.insert(user).values({ id: userId, name: 'Steering Owner', email: 'steering-integration@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await savePiSession(childId, userId, model.provider, model.id, [promptMessage], undefined, {
      agentId: 'bradley', persistedLength: 0,
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('worker system instructions', now),
    });
    const child = await db.query.piSessions.findFirst({ where: eq(piSessions.sessionId, childId) });
    assert.ok(child?.workspaceId);
    await db.update(piSessions).set({ sessionKind: 'delegation_worker', delegationDepth: 1,
      parentSessionId: parentId, delegationId }).where(eq(piSessions.id, child.id));
    await db.insert(piSessions).values({ sessionId: parentId, userId, agentId: 'bradley',
      provider: model.provider, model: model.id, sessionKind: 'conversation', delegationDepth: 0,
      workspaceId: child.workspaceId, organizationId: child.organizationId, projectId: child.projectId,
      createdAt: now, updatedAt: now });
    await db.insert(piDelegations).values({ id: delegationId, userId, sourceSessionId: parentId,
      sourceAgentId: 'bradley', workerSessionId: childId, workerType: 'ephemeral', goal: promptMessage.content,
      status: 'running', runOwnerId, runHeartbeatAt: now, createdAt: now, updatedAt: now });

    // The receipt transition must fail if the worker has not committed the
    // complete tool batch and its injected correction to the child transcript.
    const postgres = database.getPostgresRuntimeQueryable();
    await postgres.query(`
      CREATE FUNCTION assert_steering_checkpoint() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN
          IF (SELECT count(*) FROM pi_messages
              WHERE pi_session_db_id = ${child.id} AND role = 'toolResult') <> 2
             OR NOT EXISTS (SELECT 1 FROM pi_messages
              WHERE pi_session_db_id = ${child.id} AND role = 'user'
                AND content::jsonb->>'content' LIKE '%Also inspect the second file.%') THEN
            RAISE EXCEPTION 'steering receipt preceded durable complete child checkpoint';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await postgres.query(`CREATE TRIGGER check_steering_checkpoint BEFORE UPDATE ON pi_delegations_steering
      FOR EACH ROW EXECUTE FUNCTION assert_steering_checkpoint()`);

    const currentRows = async () => (await db.select().from(piMessages)
      .where(eq(piMessages.piSessionDbId, child.id))).sort((left, right) => left.sequence - right.sequence);
    let acceptedId: string | null = null;
    let modelCalls = 0;
    const streamFn: StreamFn = async (_requestedModel, context) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.equal((await currentRows()).length, 1);
        return completedStream(assistant([
          { type: 'toolCall', id: 'file-one', name: 'fixture', arguments: {} },
          { type: 'toolCall', id: 'file-two', name: 'fixture', arguments: {} },
        ], 'toolUse'));
      }
      assert.equal(modelCalls, 2, 'a single correction is injected into the next model turn');
      const rows = await currentRows();
      const messages = rows.map(row => JSON.parse(row.content) as AgentMessage);
      assert.deepEqual(messages.map(message => message.role),
        ['user', 'assistant', 'toolResult', 'toolResult', 'user'],
        'the correction is checkpointed only after both tool results');
      assert.deepEqual(messages.filter((message): message is Extract<AgentMessage, { role: 'toolResult' }> =>
        message.role === 'toolResult').map(message => message.toolCallId).sort(), ['file-one', 'file-two']);
      const correction = messages.at(-1);
      assert.match(correction?.role === 'user' ? String(correction.content) : '', /Also inspect the second file/u);
      assert.match(JSON.stringify(context.messages), /Also inspect the second file/u);
      const receipt = await db.query.piDelegationSteering.findFirst({ where: eq(piDelegationSteering.id, acceptedId!) });
      assert.equal(receipt?.status, 'claimed', 'a receipt is only delivered when the assistant starts after the checkpoint');
      return completedStream(assistant([{ type: 'text', text: 'Both files inspected with the correction.' }], 'stop'));
    };
    const fixtureTool = {
      name: 'fixture', label: 'Fixture', description: 'Inspect a test file', parameters: Type.Object({}),
      execute: async (toolCallId: string) => {
        assert.equal((await currentRows()).length, 1,
          'no assistant tool-call batch is persisted while its tools are still running');
        if (toolCallId === 'file-one') {
          const accepted = await acceptPiDelegationSteering({
            delegationId, userId, sourceSessionId: parentId,
            idempotencyKey: 'correction-1', message: correctionText,
          });
          acceptedId = accepted.id;
          assert.equal(accepted.status, 'accepted');
        }
        return { content: [{ type: 'text' as const, text: `Result for ${toolCallId}` }], details: {} };
      },
    };
    const identity = {
      organizationId: null, userId, sessionId: childId, workspaceId: child.workspaceId,
      agentId: 'bradley', workspaceType: 'personal' as const, workspaceName: null,
      customerId: null, projectId: null, workspaceRoot: root, workspaceRootRelativePath: null,
      canWrite: false, canDelete: false, canShare: false, legacy: false,
    };
    const result = await runEphemeralWorker({
      request: { delegationId, runOwnerId, userId, sourceAgentId: 'bradley', sourceSessionId: parentId,
        goal: promptMessage.content, workerRole: 'researcher', toolsets: ['file'],
        waitForResult: true, timeoutSeconds: 60 },
      sessionId: childId, promptMessage, executionContext: identity,
      baseSystemPrompt: 'worker system instructions', systemPrompt: 'worker system instructions',
      tools: [fixtureTool], signal: new AbortController().signal,
      runtime: { model, selection: { selection: { providerId: model.provider, thinkingLevel: 'off' } }, streamFn } as unknown as Parameters<typeof runEphemeralWorker>[0]['runtime'],
    });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.reply, 'Both files inspected with the correction.');
    assert.equal(modelCalls, 2);
    assert.ok(acceptedId);
    assert.equal((await db.query.piDelegationSteering.findFirst({ where: eq(piDelegationSteering.id, acceptedId) }))?.status,
      'delivered', 'the database trigger proves the receipt followed the complete persisted checkpoint');

    // A command arriving after the SDK's final poll cannot be injected. The
    // dispatcher marks it missed when the worker becomes terminal.
    const late = await acceptPiDelegationSteering({ delegationId, userId, sourceSessionId: parentId,
      idempotencyKey: 'correction-too-late', message: 'Check another file after the answer.' });
    assert.equal(late.status, 'accepted');
    await completeRunningPiDelegation({ id: delegationId, resultStatus: 'ok', resultText: result.reply, runOwnerId });
    assert.equal(await markUndeliveredPiDelegationSteeringMissed({ delegationId, userId }), 1);
    assert.equal((await db.query.piDelegationSteering.findFirst({ where: eq(piDelegationSteering.id, late.id) }))?.status, 'missed');
    assert.doesNotMatch(JSON.stringify((await currentRows()).map(row => JSON.parse(row.content))), /Check another file after the answer/u);
    console.log('pi-delegation-steering-integration-test: ok');
  } finally {
    modules._load = originalLoad;
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
