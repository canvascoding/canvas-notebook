import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatChatMarkdown } from '../app/lib/chat/markdown-export';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-chat-markdown-'));
  const previous = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = root;
  try {
    const { storeToolOutput } = await import('../app/lib/pi/tool-output-store');
    const { exportSessionMarkdown } = await import('../app/lib/chat/session-markdown-export');
    const identity = { userId: 'user-a', organizationId: null, sessionId: 'chat-a', workspaceId: 'workspace-a' };
    const largeInput = `BEGIN INPUT\n${'argument detail '.repeat(3000)}\nEND INPUT`;
    const largeOutput = `BEGIN OUTPUT\n${'middle detail '.repeat(5000)}\n\n\`\`\`\`\`js\nx()\n\`\`\`\`\`\nEND OUTPUT`;
    const stored = await storeToolOutput({ identity, toolCallId: 'call-a', format: 'text', content: largeOutput });
    assert(stored.ok);
    const { reference, manifestReference, bytes, characters, sha256, complete } = stored;
    const toolOutput = { version: 1, policyVersion: 'test', rawChars: characters, modelChars: 20, storedBytes: bytes,
      references: [{ reference, manifestReference, bytes, characters, sha256, complete }] };
    const messages = [
      ...Array.from({ length: 240 }, (_, index) => ({ id: index, role: 'user', content: `Message ${index}` })),
      { id: 240, role: 'assistant', content: [
        { type: 'text', text: '**I will inspect this.**' },
        { type: 'thinking', thinking: 'debug reasoning', thinkingSignature: 'signature-a' },
        { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'source.md', text: largeInput } },
      ], model: 'test-model', stopReason: 'toolUse' },
      { id: 241, role: 'toolResult', toolCallId: 'call-a', toolName: 'read', content: [{ type: 'text', text: 'preview' }],
        details: { toolOutput, result: { structuredContent: { rows: [1, 2] } } }, isError: true },
      { id: 242, role: 'compact-break', content: '', omittedMessageCount: 200 },
      { id: 243, role: 'custom-event', content: { diagnostic: 'custom data' }, extra: { preserved: true } },
      { id: 244, role: 'assistant', content: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }], timestamp: 100 },
    ];
    const exported = await exportSessionMarkdown({ title: 'Debug chat', sessionId: identity.sessionId, agentId: 'agent-a', messages, identity });
    assert.equal(exported.hasWarnings, false);
    const markdown = exported.markdown;
    assert(markdown.includes('Message 0'));
    assert(markdown.indexOf('Message 0') < markdown.indexOf('Message 239'), 'retain full chronological history beyond a UI page');
    assert(markdown.includes('"messageCount": 245'));
    assert(markdown.includes('#### Input'));
    assert(markdown.includes(JSON.stringify(largeInput)), 'full tool input remains in the JSON block');
    assert(markdown.includes(largeOutput), 'restore full archived output including its middle and tail');
    assert(markdown.includes('``````text\nBEGIN OUTPUT'), 'use a fence longer than nested fences');
    for (const value of ['debug reasoning', 'signature-a', 'structuredContent', 'isError', 'compact-break', 'custom data', 'image-data']) assert(markdown.includes(value), value);
    await assert.rejects(() => exportSessionMarkdown({ title: '', sessionId: identity.sessionId, agentId: 'agent-a', messages, identity: { ...identity, userId: 'foreign-user' } }), /not found|ENOENT/);

    const originalJson = await storeToolOutput({ identity, toolCallId: 'mcp-call', format: 'json',
      content: JSON.stringify({ content: [{ type: 'text', text: 'full MCP output' }], structuredContent: { original: true }, mcpAppAuthority: 'private-capability' }), complete: false });
    assert(originalJson.ok);
    const jsonMessage = { id: 245, role: 'toolResult', toolName: 'mcp', content: 'preview', details: { toolOutput: {
      ...toolOutput, references: [{ ...originalJson }], storageError: 'One source was not archived.',
    } } };
    const warned = await exportSessionMarkdown({ title: '', sessionId: identity.sessionId, agentId: 'agent-a', messages: [jsonMessage], identity });
    assert.equal(warned.hasWarnings, true);
    assert(warned.markdown.includes('Export warning:'));
    assert(warned.markdown.includes('full MCP output'));
    assert(warned.markdown.includes('"original": true'));
    assert(!warned.markdown.includes('private-capability'), 'MCP app execution authority is never exported');

    const legacy = formatChatMarkdown({ title: 'Legacy', sessionId: 'old', agentId: 'agent-a', messages: [
      { id: 1, role: 'assistant', content: 'legacy text', type: 'tool_use', toolInput: { x: 1 }, createdAt: '2026-10-13' },
    ], storedOutputs: new Map(), warnings: [] });
    assert(legacy.includes('legacy text') && legacy.includes('toolInput'));
    console.log('[Chat Markdown Export Test] passed');
  } finally {
    if (previous === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
