import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildChatExportDocument,
  formatChatExport,
  parsePersistedChatMessageForExport,
  type ChatExportLabels,
} from '../app/lib/chat/chat-export';
import { fetchCompleteChatSessionExport } from '../app/lib/chat/session-api';
import type { ChatMessage, PersistedChatMessage } from '../app/lib/chat/types';

const labels: ChatExportLabels = {
  agent: 'Agent',
  assistant: 'Assistant',
  binaryOmitted: 'Binary omitted',
  callId: 'Call ID',
  chat: 'Chat',
  compactBreak: 'Context compacted',
  details: 'Details',
  exportedAt: 'Exported at',
  input: 'Input',
  liveSnapshot: 'Live snapshot',
  model: 'Model',
  output: 'Output',
  provider: 'Provider',
  runtimePhase: 'Runtime phase',
  sessionId: 'Session ID',
  system: 'System',
  tool: 'Tool',
  user: 'User',
  workspace: 'Workspace',
};

function persisted(message: Record<string, unknown>): PersistedChatMessage {
  return message as unknown as PersistedChatMessage;
}

const parsed = parsePersistedChatMessageForExport(JSON.stringify({
  role: 'assistant',
  timestamp: 1_700_000_000_000,
  reasoning: 'private reasoning',
  content: [
    { type: 'thinking', thinking: 'private thinking' },
    { type: 'text', text: '<thinking>private tag</thinking>Visible answer' },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    { type: 'toolCall', id: 'call-1', name: 'inspect', arguments: { path: '/tmp/example' } },
  ],
}));

assert.equal('reasoning' in parsed, false);
assert.equal(JSON.stringify(parsed).includes('private'), false);
assert.equal((parsed.content as Array<Record<string, unknown>>)[0]?.text, 'Visible answer');
assert.equal((parsed.content as Array<Record<string, unknown>>)[1]?.data, '[binary image payload omitted]');
assert.deepEqual((parsed.content as Array<Record<string, unknown>>)[1]?.exportOmission, {
  kind: 'binary-image',
  originalCharacterCount: 8,
});

const longToolOutput = 'result '.repeat(5_000);
const liveMessage: ChatMessage = {
  id: 'live-tool',
  role: 'toolResult',
  content: 'partial output',
  status: 'sending',
  toolCallId: 'live-call',
  toolName: 'live_tool',
  piMessage: {
    role: 'toolResult',
    toolCallId: 'live-call',
    toolName: 'live_tool',
    content: [{ type: 'text', text: 'partial output' }],
    timestamp: 1_700_000_003_000,
  } as ChatMessage['piMessage'],
};
const document = buildChatExportDocument({
  exportedAt: '2026-09-08T12:00:00.000Z',
  runtimePhase: 'running',
  session: {
    sessionId: 'session-1',
    title: 'Debug chat',
    agentId: 'agent-1',
    agentName: 'Bradley',
    model: 'model-1',
    provider: 'provider-1',
    thinkingLevel: 'medium',
    workspaceId: 'workspace-1',
    workspaceName: 'Personal',
  },
  persistedMessages: [
    persisted({ id: 1, sequence: 1, role: 'user', content: 'Inspect the app', timestamp: 1_700_000_000_000 }),
    persisted({
      id: 2,
      sequence: 2,
      role: 'assistant',
      timestamp: 1_700_000_001_000,
      content: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'toolCall', id: 'call-1', name: 'inspect', arguments: { path: '/app' } },
      ],
    }),
    persisted({
      id: 3,
      sequence: 3,
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'inspect',
      content: [{ type: 'text', text: longToolOutput }],
      timestamp: 1_700_000_002_000,
    }),
  ],
  liveMessages: [liveMessage],
});

assert.equal(document.snapshot.active, true);
assert.equal(document.snapshot.transientMessageCount, 1);
assert.equal(document.messages.length, 4);

const markdown = formatChatExport(document, 'markdown', labels);
assert.match(markdown, /# Debug chat/);
assert.match(markdown, /### Tool: inspect/);
assert.match(markdown, /Call ID: call-1/);
assert.match(markdown, /"path": "\/app"/);
assert.equal(markdown.includes(longToolOutput.trim()), true, 'tool output must not be truncated');
assert.match(markdown, /Live snapshot/);

const text = formatChatExport(document, 'text', labels);
assert.match(text, /ASSISTANT/);
assert.match(text, /TOOL: inspect/);

const json = JSON.parse(formatChatExport(document, 'json', labels)) as typeof document;
assert.equal(json.schemaVersion, 1);
assert.equal(json.messages[2]?.message.toolCallId, 'call-1');

const chatHeaderSource = fs.readFileSync(
  path.join(process.cwd(), 'app/components/canvas-agent-chat/ChatHeader.tsx'),
  'utf8',
);
assert.ok(chatHeaderSource.includes('data-testid="chat-copy-session"'));
assert.ok(
  chatHeaderSource.indexOf('data-testid="chat-copy-session"') > chatHeaderSource.indexOf('data-testid="chat-delete-session"'),
  'copy chat must be the final chat action',
);
const dialogSource = fs.readFileSync(
  path.join(process.cwd(), 'app/components/canvas-agent-chat/ChatExportDialog.tsx'),
  'utf8',
);
assert.ok(dialogSource.includes("{ format: 'markdown'"));
assert.ok(dialogSource.includes("{ format: 'text'"));
assert.ok(dialogSource.includes("{ format: 'json'"));
for (const locale of ['de', 'en']) {
  const messages = JSON.parse(fs.readFileSync(path.join(process.cwd(), `messages/${locale}.json`), 'utf8')) as {
    chat: Record<string, string>;
  };
  assert.ok(messages.chat.copyChat);
  assert.ok(messages.chat.copyChatSensitiveWarning);
  assert.ok(messages.chat.copyChatFormatMarkdown);
  assert.ok(messages.chat.copyChatFormatText);
  assert.ok(messages.chat.copyChatFormatJson);
}

async function testPagination(): Promise<void> {
  const originalFetch = global.fetch;
  const requestedUrls: string[] = [];
  global.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const isOlderPage = url.includes('beforeSequence=2');
    const payload = isOlderPage
      ? {
          success: true,
          messages: [{ id: 1, sequence: 1, role: 'user', content: 'first', timestamp: 1 }],
          hasMoreBefore: false,
          oldestTimestamp: 1,
          oldestMessageId: 1,
          oldestSequence: 1,
        }
      : {
          success: true,
          messages: Array.from({ length: 200 }, (_, index) => ({
            id: index + 2,
            sequence: index + 2,
            role: 'assistant',
            content: `message-${index + 2}`,
            timestamp: index + 2,
          })),
          hasMoreBefore: true,
          oldestTimestamp: 2,
          oldestMessageId: 2,
          oldestSequence: 2,
        };
    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const complete = await fetchCompleteChatSessionExport({
      agentId: 'agent-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });
    assert.equal(complete.length, 201);
    assert.equal(complete[0]?.sequence, 1);
    assert.equal(complete[200]?.sequence, 201);
    assert.equal(requestedUrls.length, 2);
    assert.equal(requestedUrls.every((url) => url.includes('export=true')), true);
    assert.equal(requestedUrls.every((url) => url.includes('limit=200')), true);
  } finally {
    global.fetch = originalFetch;
  }
}

void testPagination()
  .then(() => console.log('chat export tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
