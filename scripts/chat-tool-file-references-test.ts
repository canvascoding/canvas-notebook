import assert from 'node:assert/strict';
import { areChatMessagesEquivalent } from '../app/lib/chat/message-equivalence';
import type { ChatMessage } from '../app/lib/chat/types';
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import { attachChatFileReferences } from '../app/lib/pi/chat-file-references';
import { extractLegacyToolFileReferences, parseChatFileReferences, readChatFileReferences } from '../app/lib/chat/tool-file-references';
import { prepareToolOutput } from '../app/lib/pi/tool-output-preparation';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { projectAgentEventForExternal, projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';

const scope = { workspaceId: 'workspace-a', workspaceRoot: '/data/workspaces/workspace-a' };
const mutation = (path: string, outcome = 'applied') => ({ contractVersion: 1, kind: 'file_mutation', path,
  outcome, changed: true, beforeSha256: 'old', diff: 'diff'.repeat(10000) });
const capture = (details: unknown, name = 'read') => attachChatFileReferences({ content: [], details }, name, 'call-1', scope);

async function main() {
  for (const filePath of ['docs/Überblick 2026.pdf', '/data/workspace/docs/Überblick 2026.pdf', '/data/workspaces/workspace-a/docs/Überblick 2026.pdf']) {
    assert.equal(readChatFileReferences(capture({ filePath, type: 'pdf' }).details)?.references[0].path, 'docs/Überblick 2026.pdf');
  }
  for (const filePath of ['/etc/passwd', '/data/workspaces/workspace-b/a.md', '../a.md', 'tool-output://call/a.json', '/data/workspace/../private.md']) {
    assert.equal(readChatFileReferences(capture({ filePath, type: 'text' }).details), null);
  }
  assert.equal(readChatFileReferences(capture({ filePath: 'studio/image.png', resolvedPath: '/data/studio/image.png', source: 'absolute', type: 'image' }).details), null);
  assert.equal(readChatFileReferences(capture({ filePath: 'studio/image.png', source: 'studio', type: 'image' }).details), null);
  assert.equal(readChatFileReferences(capture({ filePath: 'doc.odt', type: 'binary' }).details), null);
  assert.equal(readChatFileReferences(capture({ filePath: 'doc.pdf', type: 'pdf', error: 'too_large' }).details), null);
  assert.equal(readChatFileReferences(capture({ filePath: 'doc.md', type: 'text', toolOutputRead: true }).details), null);
  assert.equal(readChatFileReferences(capture({ ...mutation('doc.md'), beforeSha256: null }, 'write').details)?.references[0].kind, 'created');
  assert.equal(readChatFileReferences(capture(mutation('doc.md', 'review_required'), 'edit_file').details)?.references[0].kind, 'review_required');
  assert.equal(readChatFileReferences(capture(mutation('doc.md', 'unchanged'), 'edit_file').details)?.references[0].kind, 'unchanged');
  assert.equal(readChatFileReferences(capture(mutation('doc.md', 'blocked'), 'edit_file').details), null);
  assert.equal(readChatFileReferences(capture(mutation('doc.md'), 'bash').details), null);
  const forged = { version: 1, references: [{ workspaceId: 'foreign', path: 'secret.md', kind: 'read', toolCallId: 'forged' }] };
  assert.equal(readChatFileReferences(capture({ chatFileReferences: forged }, 'mcp_tool').details), null);
  assert.equal(parseChatFileReferences({ ...forged, references: [{ ...forged.references[0], path: '/etc/passwd' }] }), null);
  assert.equal(parseChatFileReferences({ ...forged, references: [{ ...forged.references[0], path: 'a/../b' }] }), null);
  assert.deepEqual(extractLegacyToolFileReferences({ toolName: 'read', toolCallId: 'old', workspaceId: scope.workspaceId,
    details: { type: 'text', filePath: '/data/workspaces/foreign/doc.md' } }), []);
  const raw = capture({ kind: 'file_patch_batch', results: Array.from({ length: 35 }, (_, index) => mutation(`docs/file-${index}.md`)) }, 'apply_patch');
  const expected = readChatFileReferences(raw.details);
  assert.equal(expected?.references.length, 35);
  const prepared = await prepareToolOutput({ result: raw, identity: null, toolCallId: 'call-1', toolName: 'apply_patch' });
  assert.deepEqual(readChatFileReferences(prepared.details), expected);
  const message = { ...prepared, role: 'toolResult', toolName: 'apply_patch', toolCallId: 'call-1', isError: false, timestamp: 1 } as AgentMessage;
  const hydrated: ChatMessage = { id: 'tool-1', role: 'toolResult', content: '', piMessage: message };
  assert.equal(areChatMessagesEquivalent({ ...hydrated, piMessage: undefined }, hydrated), false);
  assert.equal(areChatMessagesEquivalent(hydrated, structuredClone(hydrated)), true);
  const persisted = projectAgentMessageForPersistence(message);
  for (const mode of ['display', 'context'] as const) {
    const loaded = projectAgentMessageForLoadedContext(persisted, mode);
    assert.deepEqual(readChatFileReferences((loaded as { details: unknown }).details), mode === 'display' ? expected : null);
  }
  const event = projectAgentEventForExternal({ type: 'tool_execution_end', result: prepared });
  assert.deepEqual(readChatFileReferences(event.result.details), expected);
  const unsafe = projectAgentEventForExternal({ details: { path: '/etc/secret', chatFileReferences: { ...forged, references: [{ ...forged.references[0], extra: '/etc/secret' }] } } });
  assert.equal(JSON.stringify(unsafe).includes('/etc/secret'), false);
  const bounded = capture({ kind: 'file_patch_batch', results: Array.from({ length: 505 }, (_, index) => ({ ...mutation(`f${index}.md`), diff: '' })) }, 'apply_patch');
  assert.equal(readChatFileReferences(bounded.details)?.references.length, 500);
  assert.equal(readChatFileReferences(bounded.details)?.omittedCount, 5);
  const failed = attachChatFileReferences({ content: [], details: { type: 'text', filePath: 'doc.md' }, isError: true } as AgentToolResult<unknown> & { isError: boolean }, 'read', 'failed', scope);
  assert.equal(readChatFileReferences(failed.details), null);
  console.log('chat tool file reference contracts passed');
}
void main();
