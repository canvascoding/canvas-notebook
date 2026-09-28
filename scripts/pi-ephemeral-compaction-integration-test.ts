import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createPiTestDatabase } from './helpers/pi-test-database';

const model: Model<'openai-completions'> = {
  id: 'ephemeral-compaction-test',
  name: 'Ephemeral Compaction Test',
  api: 'openai-completions',
  provider: 'test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 2_048,
};

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp,
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-ephemeral-compaction-'));
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
    // CJS consumers need a shim; runEphemeralWorker imports the real ESM loop.
    if (request === '@earendil-works/pi-agent-core') return { Agent: class Agent {} };
    if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    }
    if (request === '@/app/lib/agents/workspace-file-tree-context') return {
      buildWorkspaceFileTreePrompt: async () => ({ promptBlock: 'workspace tree' }),
      replaceWorkspaceFileTreePromptBlock: () => 'worker system instructions',
    };
    return originalLoad(request, parent, isMain);
  };

  try {
    const { db } = database;
    const { piMessages, piSessionCompactionAttempts, user } = await import('../app/lib/db/schema');
    const { runEphemeralWorker } = await import('../app/lib/pi/delegate-task-tool');
    const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
    const { loadPiSessionWithSummary, savePiSession } = await import('../app/lib/pi/session-store');
    const now = new Date('2026-09-28T12:00:00.000Z');
    const userId = 'user-ephemeral-compaction';
    const sessionId = 'worker-ephemeral-compaction';
    const promptMessage = { role: 'user' as const, content: 'Collect and synthesize two batches of source results.', timestamp: now.getTime() };
    await db.insert(user).values({
      id: userId, name: 'Ephemeral Compaction Tester', email: 'ephemeral-compaction@example.test',
      emailVerified: true, image: null, role: null, createdAt: now, updatedAt: now,
    });
    await savePiSession(sessionId, userId, model.provider, model.id, [promptMessage], undefined, {
      agentId: 'canvas-agent', persistedLength: 0,
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('worker system instructions', now),
    });
    const session = await db.query.piSessions.findFirst({
      where: (table, { eq }) => eq(table.sessionId, sessionId),
    });
    assert.ok(session?.workspaceId);

    let modelCalls = 0;
    let summaryCalls = 0;
    const modelContexts: string[] = [];
    const streamFn: StreamFn = async (_requestedModel, context) => {
      if (/rolling summary|compact internal summary/i.test(context.systemPrompt || '')) {
        summaryCalls += 1;
        return completedStream(assistant([{ type: 'text', text: [
          '## Active Task',
          summaryCalls === 1 ? 'Collect and synthesize two batches of source results.' : '(none — no user-authored task in source)',
          '## Completed Work',
          '- Source results were collected.',
          '## Decisions and Constraints',
          '- Preserve source provenance and tool-call boundaries.',
          '## Files, Commands, and Exact Errors',
          '- No files or errors.',
          '## Remaining Work',
          '- Continue collecting and then synthesize the results.',
        ].join('\n') }], 'stop', now.getTime() + 100 + summaryCalls));
      }
      modelCalls += 1;
      modelContexts.push(JSON.stringify(context.messages));
      if (summaryCalls < 2) {
        assert.ok(modelCalls <= 30, 'compaction must make progress within a bounded number of tool turns');
        return completedStream(assistant([{
          type: 'toolCall' as const, id: `source-call-${modelCalls}`,
          name: 'fixture', arguments: {},
        }], 'toolUse', now.getTime() + modelCalls));
      }
      return completedStream(assistant([{ type: 'text', text: 'Both batches synthesized.' }], 'stop', now.getTime() + 200));
    };
    const identity = {
      organizationId: null, userId, sessionId, workspaceId: session.workspaceId,
      agentId: 'canvas-agent', workspaceType: 'personal' as const, workspaceName: null,
      customerId: null, projectId: null, workspaceRoot: root, workspaceRootRelativePath: null,
      canWrite: false, canDelete: false, canShare: false, legacy: false,
    };
    const fixtureTool = {
      name: 'fixture', label: 'Fixture', description: 'Return a large source result', parameters: Type.Object({}),
      execute: async (toolCallId: string) => ({
        content: [{ type: 'text' as const, text: `SOURCE ${toolCallId}: ${'durable source evidence '.repeat(350)}` }],
        details: {},
      }),
    };
    const result = await runEphemeralWorker({
      request: { userId, sourceAgentId: 'canvas-agent', sourceSessionId: 'parent-session',
        goal: promptMessage.content, workerRole: 'researcher', toolsets: ['web'],
        waitForResult: true, timeoutSeconds: 60 },
      sessionId, promptMessage, executionContext: identity,
      baseSystemPrompt: 'worker system instructions', systemPrompt: 'worker system instructions',
      tools: [fixtureTool], signal: new AbortController().signal,
      runtime: { model, selection: { selection: { providerId: model.provider, thinkingLevel: 'off' } }, streamFn } as unknown as Parameters<typeof runEphemeralWorker>[0]['runtime'],
    });
    assert.equal(result.status, 'ok', JSON.stringify({ result, modelCalls, summaryCalls }));
    assert.equal(result.reply, 'Both batches synthesized.');
    assert.ok(modelCalls > 2, 'the worker continues over multiple tool turns');
    assert.ok(summaryCalls >= 2, 'at least two real summary-provider calls are required');
    assert.match(modelContexts.at(-1) || '', /Source results were collected|canvas-session-summary:v2/,
      'the second committed summary reaches the subsequent child model request');

    const attempts = (await db.select().from(piSessionCompactionAttempts)).sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    assert.ok(attempts.length >= 2);
    assert.ok(attempts.every(attempt => attempt.state === 'succeeded'));
    assert.ok(attempts[0].committedThroughSequence! > 0);
    assert.ok(attempts[1].committedThroughSequence! > attempts[0].committedThroughSequence!);
    for (const attempt of attempts) {
      assert.ok(attempt.committedThroughSequence! <= attempt.messageSequenceCheckpoint,
        'a summary watermark must not exceed its durable raw-message checkpoint');
    }
    const reloaded = await loadPiSessionWithSummary(sessionId, userId, 'canvas-agent');
    assert.equal(reloaded?.summary.summaryRevision, attempts.length);
    assert.equal(reloaded?.summary.summaryThroughSequence, attempts.at(-1)?.committedThroughSequence);
    const rows = (await db.select().from(piMessages)).sort((left, right) => left.sequence! - right.sequence!);
    assert.deepEqual(rows.map(row => row.sequence), Array.from({ length: rows.length }, (_, index) => index + 1));
    const rawMessages = rows.map(row => JSON.parse(row.content) as AgentMessage);
    const callIds = rawMessages.flatMap(message => message.role === 'assistant'
      ? message.content.filter(part => part.type === 'toolCall').map(part => part.id)
      : []);
    const resultIds = rawMessages.flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []);
    assert.deepEqual(resultIds.slice().sort(), callIds.slice().sort(), 'every persisted tool call has exactly one persisted result');
    assert.equal(resultIds.length, modelCalls - 1);
    assert.ok(rows.some(row => row.content.includes('durable source evidence')),
      'compaction must not replace the raw persisted tool output with the short summary');
    assert.equal(rawMessages.at(-1)?.role, 'assistant');

    const failureSessionId = 'worker-ephemeral-summary-failure';
    await savePiSession(failureSessionId, userId, model.provider, model.id, [promptMessage], undefined, {
      agentId: 'canvas-agent', persistedLength: 0,
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('worker system instructions', now),
    });
    let failedSummaryCalls = 0;
    let failureModelCalls = 0;
    const failedResult = await runEphemeralWorker({
      request: { userId, sourceAgentId: 'canvas-agent', sourceSessionId: 'parent-session',
        goal: promptMessage.content, workerRole: 'researcher', toolsets: ['web'],
        waitForResult: true, timeoutSeconds: 60 },
      sessionId: failureSessionId, promptMessage,
      executionContext: { ...identity, sessionId: failureSessionId },
      baseSystemPrompt: 'worker system instructions', systemPrompt: 'worker system instructions',
      tools: [fixtureTool], signal: new AbortController().signal,
      runtime: { model, selection: { selection: { providerId: model.provider, thinkingLevel: 'off' } },
        streamFn: async (_requestedModel: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1]) => {
          if (/rolling summary|compact internal summary/i.test(context.systemPrompt || '')) {
            failedSummaryCalls += 1;
            throw new Error('synthetic summary provider failure');
          }
          failureModelCalls += 1;
          assert.ok(failureModelCalls <= 30, 'an uncompressible worker must stop rather than loop forever');
          return completedStream(assistant([{
            type: 'toolCall', id: `failed-source-call-${failureModelCalls}`, name: 'fixture', arguments: {},
          }], 'toolUse', now.getTime() + 300 + failureModelCalls));
        },
      } as unknown as Parameters<typeof runEphemeralWorker>[0]['runtime'],
    });
    assert.equal(failedResult.status, 'error');
    assert.match(failedResult.error || '', /compaction|budget/i);
    assert.ok(failedSummaryCalls > 0, 'the negative case reaches summary generation');
    const failedReload = await loadPiSessionWithSummary(failureSessionId, userId, 'canvas-agent');
    assert.equal(failedReload?.summary.summaryRevision, 0, 'a failed candidate never activates a partial summary');
    const failedSession = await db.query.piSessions.findFirst({
      where: (table, { eq }) => eq(table.sessionId, failureSessionId),
    });
    assert.ok(failedSession);
    const failedRows = await db.query.piMessages.findMany({
      where: (table, { eq }) => eq(table.piSessionDbId, failedSession.id),
    });
    assert.ok(failedRows.some(row => row.role === 'toolResult'),
      'a failed summary does not discard completed raw tool results');

    const abortSessionId = 'worker-ephemeral-summary-abort';
    await savePiSession(abortSessionId, userId, model.provider, model.id, [promptMessage], undefined, {
      agentId: 'canvas-agent', persistedLength: 0,
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('worker system instructions', now),
    });
    const abortController = new AbortController();
    let abortModelCalls = 0;
    let abortSummaryCalls = 0;
    const abortedResult = await runEphemeralWorker({
      request: { userId, sourceAgentId: 'canvas-agent', sourceSessionId: 'parent-session',
        goal: promptMessage.content, workerRole: 'researcher', toolsets: ['web'],
        waitForResult: true, timeoutSeconds: 60 },
      sessionId: abortSessionId, promptMessage,
      executionContext: { ...identity, sessionId: abortSessionId },
      baseSystemPrompt: 'worker system instructions', systemPrompt: 'worker system instructions',
      tools: [fixtureTool], signal: abortController.signal,
      runtime: { model, selection: { selection: { providerId: model.provider, thinkingLevel: 'off' } },
        streamFn: async (_requestedModel: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1]) => {
          if (/rolling summary|compact internal summary/i.test(context.systemPrompt || '')) {
            abortSummaryCalls += 1;
            queueMicrotask(() => abortController.abort(new Error('cancelled during summary')));
            return { result: () => new Promise<AssistantMessage>(() => undefined) } as Awaited<ReturnType<StreamFn>>;
          }
          abortModelCalls += 1;
          assert.ok(abortModelCalls <= 30, 'the abort fixture reaches the summary promptly');
          return completedStream(assistant([{
            type: 'toolCall', id: `aborted-source-call-${abortModelCalls}`, name: 'fixture', arguments: {},
          }], 'toolUse', now.getTime() + 400 + abortModelCalls));
        },
      } as unknown as Parameters<typeof runEphemeralWorker>[0]['runtime'],
    });
    assert.equal(abortedResult.status, 'error');
    assert.match(abortedResult.error || '', /cancel|abort/i);
    assert.equal(abortSummaryCalls, 1);
    const abortedReload = await loadPiSessionWithSummary(abortSessionId, userId, 'canvas-agent');
    assert.equal(abortedReload?.summary.summaryRevision, 0, 'an aborted summary never becomes active');
    const abortedSession = await db.query.piSessions.findFirst({
      where: (table, { eq }) => eq(table.sessionId, abortSessionId),
    });
    assert.ok(abortedSession);
    const abortedRows = await db.query.piMessages.findMany({
      where: (table, { eq }) => eq(table.piSessionDbId, abortedSession.id),
    });
    assert.ok(abortedRows.some(row => row.role === 'toolResult'),
      'an aborted summary keeps completed raw tool results');
    console.log('pi-ephemeral-compaction-integration-test: ok');
  } finally {
    modules._load = originalLoad;
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
