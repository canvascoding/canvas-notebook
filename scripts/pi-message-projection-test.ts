import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-pi-message-projection-'));
process.env.DATA = dataDir;

async function main() {
  const { eq } = await import('drizzle-orm');
  const { db } = await import('../app/lib/db');
  const { user, piMessages, piSessions } = await import('../app/lib/db/schema');
  const { savePiSession, loadPiSessionWithSummary } = await import('../app/lib/pi/session-store');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const { parsePersistedPiMessage } = await import('../app/lib/pi/message-projection');

  const now = new Date();
  const userId = 'user-projection';
  const sessionId = 'sess-projection';
  const uniqueTailMarker = 'UNIQUE_RAW_TAIL_MARKER_9d9f20f1';
  const hugeText = `%PDF-1.4\n${'raw-pdf-body '.repeat(60_000)}${uniqueTailMarker}`;
  const imageData = 'a'.repeat(250_000);

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

  const messages: AgentMessage[] = [
    { role: 'user', content: 'read the pdf', timestamp: now.getTime() } as AgentMessage,
    {
      role: 'toolResult',
      toolName: 'read',
      toolCallId: 'tool-projection',
      content: [
        { type: 'text', text: hugeText },
        { type: 'image', data: imageData, mimeType: 'image/png' },
      ],
      details: {
        filePath: '/data/workspace/case.pdf',
        stdout: hugeText,
      },
      timestamp: now.getTime() + 1,
    } as unknown as AgentMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'I read the PDF.' }],
      api: 'test',
      provider: 'test-provider',
      model: 'test-model',
      stopReason: 'stop',
      timestamp: now.getTime() + 2,
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
  assert.ok(rawContent.includes(imageData.slice(0, 200)));

  const rawMessage = parsePersistedPiMessage(rawContent, 'raw') as unknown as Record<string, unknown>;
  assert.equal(JSON.stringify(rawMessage).length, rawContent.length);
  const rawParts = rawMessage.content as Array<Record<string, unknown>>;
  assert.equal(rawParts[0].text, hugeText);
  assert.equal(rawParts[1].data, imageData);

  const loaded = await loadPiSessionWithSummary(sessionId, userId, 'canvas-agent');
  assert.ok(loaded);
  const projectedTool = loaded.messages.find((message) => message.role === 'toolResult') as unknown as Record<string, unknown>;
  assert.ok(projectedTool);
  const projectedJson = JSON.stringify(projectedTool);
  assert.ok(projectedJson.length < 60_000);
  assert.match(projectedJson, /raw database record/);
  assert.ok(rawContent.includes(uniqueTailMarker));
  assert.doesNotMatch(projectedJson, new RegExp(uniqueTailMarker));
  assert.doesNotMatch(projectedJson, new RegExp(imageData.slice(0, 200)));

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
}

main()
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
