import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { drizzle } from 'drizzle-orm/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import * as schema from '../app/lib/db/schema';
import { MAIN_AGENT_ID } from '../app/lib/agents/main-agent';
import { piMetadataFixture, piToolMetadataFixture } from './helpers/pi-message-fixture';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-pi-message-projection-'));
process.env.DATA = dataDir;
let postgres: PGlite | null = null;
let database: ReturnType<typeof drizzle<typeof schema>>;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (
    request === '@/app/lib/db'
    || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request)
    || /^(?:\.\.\/)+db$/u.test(request)
  ) {
    return {
      db: database,
      openDb: async () => ({
        get: async (sql: string, params: unknown[] = []) => (await postgres!.query(sql, params)).rows[0],
        all: async (sql: string, params: unknown[] = []) => (await postgres!.query(sql, params)).rows,
        run: async (sql: string, params: unknown[] = []) => { await postgres!.query(sql, params); },
        close: async () => {},
      }),
    };
  }
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  postgres = new PGlite();
  await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
  database = drizzle(postgres, { schema });
  const { eq } = await import('drizzle-orm');
  const db = database;
  const { user, piMessages, piSessions } = await import('../app/lib/db/schema');
  const { savePiSession, loadPiSessionWithSummary } = await import('../app/lib/pi/session-store');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const {
    parsePersistedPiMessage,
    projectAgentMessageForLoadedContext,
  } = await import('../app/lib/pi/message-projection');
  const { normalizePiMessagesForLlm } = await import('../app/lib/pi/message-normalization');

  const now = new Date();
  const userId = 'user-projection';
  const sessionId = 'sess-projection';
  const uniqueTailMarker = 'UNIQUE_RAW_TAIL_MARKER_9d9f20f1';
  const hugeText = `%PDF-1.4\n${'raw-pdf-body '.repeat(60_000)}${uniqueTailMarker}`;
  const imageData = 'A'.repeat(9_000_000);

  await db.insert(user).values({
    id: userId,
    name: 'Projection Tester',
    email: 'projection@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const userImageMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'attached image' },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ],
    timestamp: now.getTime() + 1,
  } as unknown as AgentMessage;
  const toolResultMessage = {
    role: 'toolResult',
    toolName: 'read',
    toolCallId: 'tool-projection',
    content: [
      { type: 'text', text: hugeText },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ],
    details: {
      filePath: 'case.pdf',
      resolvedPath: '/private/runtime/workspace/case.pdf',
      type: 'image',
      mimeType: 'image/png',
      previewUrl: '/api/files/preview?path=case.pdf&w=192&preset=mini',
      mediaUrl: '/api/media/case.pdf',
      stdout: hugeText,
    },
    timestamp: now.getTime() + 2,
  } as unknown as AgentMessage;

  const messages: AgentMessage[] = [
    { role: 'user', content: 'read the pdf', timestamp: now.getTime() } as AgentMessage,
    userImageMessage,
    toolResultMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'I read the PDF.' }],
      api: 'test',
      provider: 'test-provider',
      model: 'test-model',
      stopReason: 'stop',
      timestamp: now.getTime() + 3,
    } as AgentMessage,
  ];

  await savePiSession(
    sessionId,
    userId,
    'test-provider',
    'test-model',
    messages,
    undefined,
    {
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('test prompt', now),
    },
  );

  const rows = await db.select().from(piMessages).where(eq(piMessages.role, 'toolResult'));
  assert.equal(rows.length, 1);
  const rawContent = rows[0].content;
  assert.ok(rawContent.includes('raw-pdf-body'));
  assert.doesNotMatch(rawContent, new RegExp(imageData.slice(0, 200)));
  assert.doesNotMatch(rawContent, /private\/runtime\/workspace/);

  const rawMessage = parsePersistedPiMessage(rawContent, 'raw') as unknown as Record<string, unknown>;
  assert.equal(JSON.stringify(rawMessage).length, rawContent.length);
  const rawParts = rawMessage.content as Array<Record<string, unknown>>;
  assert.equal(rawParts[0].text, hugeText);
  assert.match(String(rawParts[1].text), /omitted from persisted chat history/);

  const loaded = await loadPiSessionWithSummary(sessionId, userId, MAIN_AGENT_ID);
  assert.ok(loaded);
  const projectedTool = loaded.messages.find((message) => message.role === 'toolResult') as unknown as Record<string, unknown>;
  assert.ok(projectedTool);
  const projectedJson = JSON.stringify(projectedTool);
  assert.ok(projectedJson.length < 60_000);
  assert.match(projectedJson, /raw database record/);
  assert.ok(rawContent.includes(uniqueTailMarker));
  assert.doesNotMatch(projectedJson, new RegExp(uniqueTailMarker));
  assert.doesNotMatch(projectedJson, new RegExp(imageData.slice(0, 200)));
  const projectedToolDetails = projectedTool.details as Record<string, unknown>;
  assert.equal(projectedToolDetails.filePath, 'case.pdf');
  assert.equal(projectedToolDetails.type, 'image');
  assert.equal(projectedToolDetails.mimeType, 'image/png');
  assert.match(String(projectedToolDetails.previewUrl), /absolute server path omitted/);
  assert.match(String(projectedToolDetails.mediaUrl), /absolute server path omitted/);
  assert.equal(projectedToolDetails.resolvedPath, undefined);

  const projectedUserImage = loaded.messages.find((message) => {
    const content = (message as unknown as { content?: unknown }).content;
    return message.role === 'user' && Array.isArray(content);
  });
  assert.ok(projectedUserImage);
  const projectedUserJson = JSON.stringify(projectedUserImage);
  assert.match(projectedUserJson, /image omitted from persisted chat history/);
  assert.doesNotMatch(projectedUserJson, new RegExp(imageData.slice(0, 200)));

  const normalizedForLlm = await normalizePiMessagesForLlm([userImageMessage, toolResultMessage]);
  const normalizedJson = JSON.stringify(normalizedForLlm[0]);
  assert.ok(normalizedJson.length < 60_000);
  assert.match(normalizedJson, /image omitted from loaded chat context/);
  assert.doesNotMatch(normalizedJson, new RegExp(imageData.slice(0, 200)));

  const normalizedToolJson = JSON.stringify(normalizedForLlm[1]);
  assert.ok(normalizedToolJson.length < 60_000);
  assert.match(normalizedToolJson, /raw database record/);
  assert.doesNotMatch(normalizedToolJson, new RegExp(uniqueTailMarker));
  assert.doesNotMatch(normalizedToolJson, new RegExp(imageData.slice(0, 200)));

  const mcpToolResult = {
    role: 'toolResult',
    toolName: 'account_lookup',
    toolCallId: 'mcp-projection-tool',
    content: [{ type: 'text', text: 'MCP account lookup completed.' }],
    details: {
      mcpApp: {
        version: 1,
        connectionId: 'mcp-connection-1',
        toolName: 'account_lookup',
        resourceUri: 'https://mcp.fixture.test/resource',
        internalWidgetDescriptor: { token: 'WIDGET_DESCRIPTOR_MUST_NOT_REACH_MODEL' },
      },
      mcpToolInput: { args: { accountId: 'MCP_INPUT_MUST_NOT_REACH_MODEL' } },
      result: {
        content: [
          { type: 'text', text: 'MCP result text.' },
          { type: 'image', data: 'MCP_PERSISTED_BINARY_PAYLOAD', mimeType: 'image/png' },
        ],
        structuredContent: {
          account: 'safe model result',
          args: { businessField: 'GENERIC_ARGS_MUST_REACH_MODEL' },
        },
        _meta: {
          args: 'MCP_META_ARGS_MUST_NOT_REACH_MODEL',
          internalWidgetDescriptor: 'MCP_META_WIDGET_MUST_NOT_REACH_MODEL',
          original: 'MCP_PERSISTED_META_PAYLOAD',
        },
      },
    },
    timestamp: now.getTime() + 4,
  } as unknown as AgentMessage;
  const mcpContext = projectAgentMessageForLoadedContext(mcpToolResult, 'context') as unknown as Record<string, unknown>;
  const mcpContextJson = JSON.stringify(mcpContext);
  assert.match(mcpContextJson, /safe model result/);
  assert.match(mcpContextJson, /GENERIC_ARGS_MUST_REACH_MODEL/);
  assert.doesNotMatch(mcpContextJson, /MCP_INPUT_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(mcpContextJson, /MCP_META_ARGS_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(mcpContextJson, /MCP_META_WIDGET_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(mcpContextJson, /WIDGET_DESCRIPTOR_MUST_NOT_REACH_MODEL/);
  assert.doesNotMatch(mcpContextJson, /mcpApp/);
  assert.doesNotMatch(mcpContextJson, /mcpToolInput/);

  const mcpDisplay = projectAgentMessageForLoadedContext(mcpToolResult, 'display') as unknown as Record<string, unknown>;
  const mcpDisplayJson = JSON.stringify(mcpDisplay);
  assert.match(mcpDisplayJson, /MCP_INPUT_MUST_NOT_REACH_MODEL/);
  assert.match(mcpDisplayJson, /MCP_META_ARGS_MUST_NOT_REACH_MODEL/);
  assert.match(mcpDisplayJson, /WIDGET_DESCRIPTOR_MUST_NOT_REACH_MODEL/);

  await savePiSession(
    'sess-mcp-projection',
    userId,
    'test-provider',
    'test-model',
    [mcpToolResult],
    undefined,
    { systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('mcp prompt', now) },
  );
  const loadedMcpSession = await loadPiSessionWithSummary(
    'sess-mcp-projection',
    userId,
    MAIN_AGENT_ID,
    { projectionMode: 'display' },
  );
  const loadedMcpMessage = loadedMcpSession?.messages[0] as unknown as Record<string, unknown>;
  assert.match(JSON.stringify(loadedMcpMessage.details), /MCP_META_ARGS_MUST_NOT_REACH_MODEL/);
  assert.match(JSON.stringify(loadedMcpMessage.details), /MCP_PERSISTED_BINARY_PAYLOAD/);
  assert.match(JSON.stringify(loadedMcpMessage.details), /MCP_PERSISTED_META_PAYLOAD/);

  const displayMcpPayload = `MCP_DISPLAY_500KB_${'x'.repeat(500_000)}`;
  const displayMcpMessage = {
    ...mcpToolResult,
    details: {
      ...(mcpToolResult as unknown as { details: Record<string, unknown> }).details,
      result: { content: [{ type: 'text', text: displayMcpPayload }], _meta: { retained: 'MCP_DISPLAY_META' } },
    },
  } as AgentMessage;
  await savePiSession(
    'sess-mcp-display-projection', userId, 'test-provider', 'test-model', [displayMcpMessage], undefined,
    { systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('display mcp prompt', now) },
  );
  const loadedDisplayMcp = await loadPiSessionWithSummary(
    'sess-mcp-display-projection', userId, MAIN_AGENT_ID, { projectionMode: 'display' },
  );
  const loadedDisplayMcpJson = JSON.stringify((loadedDisplayMcp?.messages[0] as unknown as Record<string, unknown>).details);
  assert.match(loadedDisplayMcpJson, /MCP_DISPLAY_500KB_/);
  assert.match(loadedDisplayMcpJson, /MCP_DISPLAY_META/);
  const loadedContextMcp = await loadPiSessionWithSummary('sess-mcp-display-projection', userId, MAIN_AGENT_ID);
  const loadedContextMcpJson = JSON.stringify((loadedContextMcp?.messages[0] as unknown as Record<string, unknown>).details);
  assert.ok(loadedContextMcpJson.length < 20_000);
  assert.doesNotMatch(loadedContextMcpJson, /MCP_DISPLAY_META/);

  const oversizedMcpToolResult = {
    ...mcpToolResult,
    details: {
      ...(mcpToolResult as unknown as { details: Record<string, unknown> }).details,
      result: { content: [{ type: 'text', text: 'MCP_OVERSIZED_RESULT '.repeat(120_000) }] },
    },
  } as AgentMessage;
  const oversizedMcpDisplay = projectAgentMessageForLoadedContext(oversizedMcpToolResult, 'display') as unknown as Record<string, unknown>;
  const oversizedMcpDetails = oversizedMcpDisplay.details as Record<string, unknown>;
  assert.ok(JSON.stringify(oversizedMcpDetails).length < 2 * 1024 * 1024);
  assert.deepEqual(oversizedMcpDetails.mcpApp, {
    version: 1,
    connectionId: 'mcp-connection-1',
    toolName: 'account_lookup',
    resourceUri: 'https://mcp.fixture.test/resource',
  });
  await savePiSession(
    'sess-mcp-oversized-projection',
    userId,
    'test-provider',
    'test-model',
    [oversizedMcpToolResult],
    undefined,
    { systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('oversized mcp prompt', now) },
  );
  const persistedOversizedMcp = await loadPiSessionWithSummary(
    'sess-mcp-oversized-projection',
    userId,
    MAIN_AGENT_ID,
    { projectionMode: 'display' },
  );
  const persistedOversizedMcpDetails = (persistedOversizedMcp?.messages[0] as unknown as Record<string, unknown>)
    .details as Record<string, unknown>;
  assert.ok(JSON.stringify(persistedOversizedMcpDetails).length < 2 * 1024 * 1024);
  assert.deepEqual(persistedOversizedMcpDetails.mcpApp, oversizedMcpDetails.mcpApp);
  assert.match(JSON.stringify(persistedOversizedMcpDetails.result), /persistence limit/);

  const activitySessionId = 'sess-activity-clock';
  const staleAssistantTimestamp = new Date('2024-01-01T00:00:00.000Z').getTime();
  const futureAssistantTimestamp = new Date('2025-01-01T00:00:00.000Z').getTime();
  const activityMessages: AgentMessage[] = [
    { role: 'user', content: 'activity test', timestamp: staleAssistantTimestamp - 1_000 } as AgentMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'first assistant' }],
      api: 'test',
      provider: 'test-provider',
      model: 'test-model',
      stopReason: 'stop',
      timestamp: futureAssistantTimestamp,
    } as AgentMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'last assistant in sequence' }],
      api: 'test',
      provider: 'test-provider',
      model: 'test-model',
      stopReason: 'stop',
      timestamp: staleAssistantTimestamp,
    } as AgentMessage,
  ];

  const activityBeforeSave = Date.now();
  await savePiSession(
    activitySessionId,
    userId,
    'test-provider',
    'test-model',
    activityMessages,
    undefined,
    {
      systemPromptSnapshot: buildPiSystemPromptSnapshotFromText('activity prompt', now),
    },
  );
  const activityAfterSave = Date.now();

  const activitySession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, activitySessionId),
  });
  assert.ok(activitySession?.lastMessageAt);
  const persistedActivityTime = activitySession.lastMessageAt.getTime();
  assert.ok(persistedActivityTime >= activityBeforeSave - 1_000);
  assert.ok(persistedActivityTime <= activityAfterSave + 1_000);
  assert.notEqual(persistedActivityTime, futureAssistantTimestamp);
  assert.notEqual(persistedActivityTime, staleAssistantTimestamp);

  await savePiSession(
    activitySessionId,
    userId,
    'test-provider',
    'test-model',
    activityMessages,
  );

  const afterFullResave = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, activitySessionId),
  });
  assert.equal(afterFullResave?.lastMessageAt?.toISOString(), activitySession.lastMessageAt.toISOString());

  await savePiSession(
    activitySessionId,
    userId,
    'test-provider',
    'test-model',
    [
      ...activityMessages,
      { role: 'user', content: 'user-only follow-up', timestamp: Date.now() } as AgentMessage,
    ],
    undefined,
    { persistedLength: activityMessages.length },
  );

  const afterUserOnlySave = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, activitySessionId),
  });
  assert.equal(afterUserOnlySave?.lastMessageAt?.toISOString(), activitySession.lastMessageAt.toISOString());

  const metadataMessages = [
    { role: 'user' as const, content: 'Inspect', timestamp: 999 },
    piMetadataFixture,
    piToolMetadataFixture,
  ];
  const metadataSessionId = 'metadata-roundtrip';
  await savePiSession(metadataSessionId, userId, 'openai', 'fixture-model', metadataMessages);
  const metadataLoaded = await loadPiSessionWithSummary(metadataSessionId, userId, MAIN_AGENT_ID);
  assert.deepEqual(metadataLoaded?.messages, metadataMessages);
  assert.deepEqual(await normalizePiMessagesForLlm(metadataLoaded!.messages), metadataMessages);
  const { buildPiUsageFingerprint, persistPiUsageEvents } = await import('../app/lib/pi/usage-events');
  assert.equal(buildPiUsageFingerprint(metadataSessionId, metadataLoaded!.messages[1] as typeof piMetadataFixture), buildPiUsageFingerprint(metadataSessionId, piMetadataFixture));
  await persistPiUsageEvents({ sessionId: metadataSessionId, userId, messages: metadataMessages });
  await persistPiUsageEvents({ sessionId: metadataSessionId, userId, messages: metadataLoaded!.messages });
  const usageRows = await db.select().from(schema.piUsageEvents).where(eq(schema.piUsageEvents.sessionId, metadataSessionId));
  assert.equal(usageRows.length, 1, 'replay must not duplicate the original response usage');
  console.log('Pi message persistence and metadata roundtrip tests passed');
}

main()
  .finally(async () => {
    moduleInternals._load = originalLoad;
    await postgres?.close();
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
