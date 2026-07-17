import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { serializeCanonicalText } from '../app/lib/collaboration/persistence';
import { issueCollaborationTicket, verifyCollaborationTicket } from '../app/lib/collaboration/ticket';

process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'test-only-collaboration-ticket-secret-0001';

const plain = createPlainTextYDoc('one\ntwo\n');
const update = Y.encodeStateAsUpdate(plain);
const restored = new Y.Doc({ gc: true });
Y.applyUpdate(restored, update);
assert.equal(restored.getText('content').toString(), 'one\ntwo\n');
assert.deepEqual(Y.encodeStateAsUpdate(restored), update, 'binary Yjs state must roundtrip deterministically');

const offline = new Y.Doc({ gc: true });
Y.applyUpdate(offline, update);
offline.getText('content').insert(3, ' offline');
Y.applyUpdate(plain, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(plain)));
assert.equal(plain.getText('content').toString(), 'one offline\ntwo\n');

const markdown = '---\ntitle: Test\n---\n\n# Hello\n\nParagraph with **bold**.\n';
const rich = createRichMarkdownYDoc(markdown);
assert.equal(rich.getXmlFragment('body').length > 0, true);
assert.equal(richMarkdownFromYDoc(rich).trim(), markdown.trim());

assert.equal(serializeCanonicalText('a\nb\n', { newlineStyle: 'crlf', hasBom: true }), '\uFEFFa\r\nb\r\n');

const issued = issueCollaborationTicket({
  userId: 'user-a', sessionId: 'session-a', workspaceId: 'workspace-a', organizationId: 'org-a',
  documentId: 'doc-a', path: 'notes.md', provider: 'yjs', representation: 'plain_text', permission: 'write', lifecycleGeneration: 1,
}, 10_000);
assert.equal(verifyCollaborationTicket(issued.token, 10_001).documentId, 'doc-a');

plain.destroy();
offline.destroy();
restored.destroy();
rich.destroy();
console.log('file-live-collaboration-test: ok');
