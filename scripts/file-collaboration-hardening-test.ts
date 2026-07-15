import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { issueCollaborationTicket, verifyCollaborationTicket } from '../app/lib/collaboration/ticket';
import {
  applyAgentTextTargets,
  createAgentTextTarget,
  createRichAgentTextTargets,
} from '../app/lib/collaboration/agent-operations';
import {
  createRichMarkdownYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from '../app/lib/collaboration/markdown-state';
import { isCollaborationWebSocketRequest } from '../server/collaboration-server';

process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'test-only-collaboration-ticket-secret-0002';
assert.equal(isCollaborationWebSocketRequest('/ws/collaboration?token=redacted'), true);
assert.equal(isCollaborationWebSocketRequest('/de/ws/collaboration'), true);
assert.equal(isCollaborationWebSocketRequest('/ws/chat'), false);
const issued = issueCollaborationTicket({
  userId: 'u', sessionId: 's', workspaceId: 'w', organizationId: null, documentId: 'd', path: 'a.txt',
  representation: 'plain_text', permission: 'read', lifecycleGeneration: 2,
}, 1_000);
const [ticketPayload, ticketSignature] = issued.token.split('.');
const tamperedPayload = `${ticketPayload[0] === 'a' ? 'b' : 'a'}${ticketPayload.slice(1)}`;
assert.throws(() => verifyCollaborationTicket(`${tamperedPayload}.${ticketSignature}`, 1_001), /signature/);
assert.throws(() => verifyCollaborationTicket(issued.token, 100_000), /expired/);

const unicodeDoc = new Y.Doc({ gc: true });
const unicode = unicodeDoc.getText('content');
unicode.insert(0, 'A👨‍👩‍👧‍👦e\u0301Z');
assert.throws(() => createAgentTextTarget({ text: unicode, from: 2, to: 3, replacement: 'x' }), /grapheme/);
const target = createAgentTextTarget({ text: unicode, from: 1, to: unicode.toString().length - 1, replacement: 'family' });
const result = applyAgentTextTargets({
  doc: unicodeDoc,
  targets: [target],
  origin: { actorType: 'agent', actorId: 'agent', initiatedByUserId: 'user', operationId: 'operation' },
});
assert.equal(result.status, 'applied_to_ydoc');
assert.equal(unicode.toString(), 'AfamilyZ');

const duplicateDoc = new Y.Doc({ gc: true });
const duplicate = duplicateDoc.getText('content');
duplicate.insert(0, 'same');
const once = createAgentTextTarget({ text: duplicate, from: 0, to: 4, replacement: 'changed' });
applyAgentTextTargets({ doc: duplicateDoc, targets: [once], origin: { actorType: 'agent', actorId: 'a', initiatedByUserId: 'u', operationId: '1' } });
assert.equal(applyAgentTextTargets({ doc: duplicateDoc, targets: [once], origin: { actorType: 'agent', actorId: 'a', initiatedByUserId: 'u', operationId: '2' } }).status, 'needs_review');

const richDoc = createRichMarkdownYDoc('# Heading\n\nAlpha **bold** beta\n\nSecond paragraph');
assert.equal(validateRichMarkdownYDoc(richDoc).valid, true, 'server-created rich documents require unique stable IDs');
const richTargets = createRichAgentTextTargets({ doc: richDoc, search: 'bold', replacement: 'strong' });
const richResult = applyAgentTextTargets({
  doc: richDoc,
  targets: richTargets,
  validateClone: (clone) => validateRichMarkdownYDoc(clone).valid ? null : 'schema_invalid',
  origin: { actorType: 'agent', actorId: 'rich-agent', initiatedByUserId: 'user', operationId: 'rich-operation' },
});
assert.equal(richResult.status, 'applied_to_ydoc');
assert.match(richMarkdownFromYDoc(richDoc), /Alpha \*\*strong\*\* beta/u, 'rich agent edits preserve a uniform mark');

const imeRichTarget = createRichAgentTextTargets({ doc: richDoc, search: 'Second', replacement: 'Other' });
const beforeIme = richMarkdownFromYDoc(richDoc);
const imeRichResult = applyAgentTextTargets({
  doc: richDoc,
  targets: imeRichTarget,
  compositionRanges: [{ textName: 'body', from: 1, to: 1 }],
  validateClone: (clone) => validateRichMarkdownYDoc(clone).valid ? null : 'schema_invalid',
  origin: { actorType: 'agent', actorId: 'rich-agent', initiatedByUserId: 'user', operationId: 'rich-ime' },
});
assert.equal(imeRichResult.status, 'needs_review');
assert.equal(imeRichResult.conflicts[0]?.code, 'ime_composition');
assert.equal(richMarkdownFromYDoc(richDoc), beforeIme, 'active rich IME composition must not be mutated');

const invalidRichDoc = createRichMarkdownYDoc('First paragraph\n\nSecond paragraph');
const invalidBody = invalidRichDoc.getXmlFragment('body');
const firstBlock = invalidBody.get(0) as Y.XmlElement;
const secondBlock = invalidBody.get(1) as Y.XmlElement;
secondBlock.setAttribute('id', firstBlock.getAttribute('id') || 'duplicate-id');
const invalidTarget = createRichAgentTextTargets({ doc: invalidRichDoc, search: 'First', replacement: 'Changed' });
const invalidBefore = Y.encodeStateAsUpdate(invalidRichDoc);
const invalidResult = applyAgentTextTargets({
  doc: invalidRichDoc,
  targets: invalidTarget,
  validateClone: (clone) => validateRichMarkdownYDoc(clone).code || null,
  origin: { actorType: 'agent', actorId: 'rich-agent', initiatedByUserId: 'user', operationId: 'invalid-rich' },
});
assert.equal(invalidResult.status, 'needs_review');
assert.equal(invalidResult.conflicts[0]?.code, 'stable_id_duplicate');
assert.deepEqual(Y.encodeStateAsUpdate(invalidRichDoc), invalidBefore, 'invalid clone preflight must not mutate the authoritative Y.Doc');

assert.throws(
  () => createRichAgentTextTargets({ doc: richDoc, search: 'paragraph\nmissing-boundary', replacement: 'x' }),
  /requires review/u,
  'rich targets may not cross structural node boundaries',
);

unicodeDoc.destroy(); duplicateDoc.destroy(); richDoc.destroy(); invalidRichDoc.destroy();
console.log('file-collaboration-hardening-test: ok');
