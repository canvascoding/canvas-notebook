import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { stripInternalProjectionNotices } from '../app/lib/chat/display-text';
import { extractPiMessageText, extractToolResultText } from '../app/lib/chat/message-content';
import { projectAgentEventForExternal, projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';

const imageNotice = '[image/png image omitted from persisted chat history; reopen or read the authorized source to analyze it.]';
const pathNotice = '[absolute server path omitted from live event]';
const original = {
  role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: false, timestamp: 1,
  content: [{ type: 'text', text: 'Image read successfully.' }, { type: 'image', data: 'BINARY', mimeType: 'image/png' }],
} as AgentMessage;
const persisted = projectAgentMessageForPersistence(original);
const live = projectAgentEventForExternal({ type: 'tool_execution_end', result: original });
assert.match(JSON.stringify(persisted), /omitted from persisted chat history/);
assert.doesNotMatch(JSON.stringify(persisted), /BINARY/);
assert.equal(extractPiMessageText(persisted), 'Image read successfully.');
assert.equal(extractToolResultText((live.result as { content: unknown[] }).content).trim(), 'Image read successfully.');
assert.equal(stripInternalProjectionNotices(`Read ${pathNotice}`), 'Read ');
assert.equal(stripInternalProjectionNotices(imageNotice), '');
assert.equal(stripInternalProjectionNotices('[image/png image omitted from loaded chat context (9999999 inline characters); raw image remains in database]'), '');
const ordinary = 'The report omitted a section. [Keep this reference] [An unrelated image omitted from history]';
assert.equal(stripInternalProjectionNotices(ordinary), ordinary);
assert.equal(extractPiMessageText({ role: 'user', content: `Why does ${imageNotice} appear?`, timestamp: 1 } as AgentMessage), `Why does ${imageNotice} appear?`);
assert.equal(extractPiMessageText({ role: 'assistant', content: [{ type: 'text', text: `Done.\n${imageNotice}` }] } as AgentMessage), 'Done.');
console.log('chat-projection-display-test: ok');
