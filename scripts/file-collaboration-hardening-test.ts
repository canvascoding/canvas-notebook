import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';
import { issueCollaborationTicket, verifyCollaborationTicket } from '../app/lib/collaboration/ticket';
import {
  applyAgentTextTargets,
  createAgentTextTarget,
  createRichAgentTextTargets,
  createRichMarkdownReviewTarget,
} from '../app/lib/collaboration/agent-operations';
import {
  checkpointCommitRecoveryDecision,
  confirmCheckpointMaterialization,
} from '../app/lib/collaboration/persistence';
import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from '../app/lib/collaboration/markdown-state';
import { TiptapTransformer } from '../app/lib/collaboration/server-runtime';
import { readCollaborationOperationIdempotencyKey } from '../app/lib/collaboration/operation-route';
import { isCollaborationWebSocketRequest } from '../server/collaboration-server';

process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'test-only-collaboration-ticket-secret-0002';
assert.equal(isCollaborationWebSocketRequest('/ws/collaboration?token=redacted'), true);
assert.equal(isCollaborationWebSocketRequest('/de/ws/collaboration'), true);
assert.equal(isCollaborationWebSocketRequest('/ws/chat'), false);
const issued = issueCollaborationTicket({
  userId: 'u', sessionId: 's', workspaceId: 'w', organizationId: null, documentId: 'd', path: 'a.txt',
  provider: 'yjs', representation: 'plain_text', permission: 'read', lifecycleGeneration: 2,
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

const structuralSource = '# Heading\n\nAlpha **strong** beta';
assert.throws(
  () => createRichAgentTextTargets({ doc: richDoc, search: 'beta\n\nSecond', replacement: 'x' }),
  /requires review/u,
  'rich direct targets may not cross structural node boundaries',
);
const structuralReview = createRichMarkdownReviewTarget({
  currentMarkdown: structuralSource,
  proposedMarkdown: 'Alpha **strong** beta',
  edits: [{ oldText: '# Heading\n\n', newText: '' }],
});
assert.equal(structuralReview.kind, 'rich_markdown_patch');
assert.equal(structuralReview.patchEdits?.[0]?.oldText, '# Heading\n\n');
assert.throws(
  () => applyAgentTextTargets({
    doc: richDoc,
    targets: [structuralReview],
    origin: { actorType: 'agent', actorId: 'rich-agent', initiatedByUserId: 'user', operationId: 'structural-review' },
  }),
  /review path/u,
  'structural review patches must never enter the direct text-target path',
);

type RichJsonNode = {
  attrs?: { id?: unknown };
  content?: RichJsonNode[];
  text?: string;
};

function richJsonText(node: RichJsonNode): string {
  return typeof node.text === 'string'
    ? node.text
    : (node.content || []).map(richJsonText).join('');
}

function richTopLevelBlocks(doc: Y.Doc): Array<{ id: string; text: string }> {
  const json = TiptapTransformer.fromYdoc(doc, 'body') as RichJsonNode;
  return (json.content || []).map((node) => ({
    id: typeof node.attrs?.id === 'string' ? node.attrs.id : '',
    text: richJsonText(node),
  }));
}

const structuralDoc = createRichMarkdownYDoc(
  '# Stable heading\n\nEditable paragraph.\n\nUntouched paragraph.\n',
);
const anchoredUntouchedTarget = createRichAgentTextTargets({
  doc: structuralDoc,
  search: 'Untouched',
  replacement: 'Anchored',
});
const blocksBeforeStructuralEdit = richTopLevelBlocks(structuralDoc);
replaceRichMarkdownInYDoc(
  structuralDoc,
  '# Stable heading\n\nInserted paragraph.\n\nEditable paragraph changed.\n\nUntouched paragraph.\n',
  { actorType: 'agent', actorId: 'structural-agent' },
);
const blocksAfterStructuralEdit = richTopLevelBlocks(structuralDoc);
for (const [beforeText, afterText] of [
  ['Stable heading', 'Stable heading'],
  ['Editable paragraph.', 'Editable paragraph changed.'],
  ['Untouched paragraph.', 'Untouched paragraph.'],
] as const) {
  assert.equal(
    blocksAfterStructuralEdit.find((block) => block.text === afterText)?.id,
    blocksBeforeStructuralEdit.find((block) => block.text === beforeText)?.id,
    `a structurally corresponding ${beforeText} block must retain its stable ID`,
  );
}
assert.equal(
  blocksBeforeStructuralEdit.some((block) => (
    block.id === blocksAfterStructuralEdit.find((candidate) => candidate.text === 'Inserted paragraph.')?.id
  )),
  false,
  'a newly inserted rich block must receive a fresh stable ID',
);
const anchoredAfterStructuralEdit = applyAgentTextTargets({
  doc: structuralDoc,
  targets: anchoredUntouchedTarget,
  validateClone: (clone) => validateRichMarkdownYDoc(clone).valid ? null : 'schema_invalid',
  origin: {
    actorType: 'agent',
    actorId: 'anchored-agent',
    initiatedByUserId: 'user',
    operationId: 'anchored-after-structural-edit',
  },
});
assert.equal(
  anchoredAfterStructuralEdit.status,
  'applied_to_ydoc',
  'an agent RelativePosition in an untouched rich block must survive a structural review edit',
);
assert.match(richMarkdownFromYDoc(structuralDoc), /Anchored paragraph\./u);

unicodeDoc.destroy(); duplicateDoc.destroy(); richDoc.destroy(); invalidRichDoc.destroy(); structuralDoc.destroy();

async function assertOperationBodyHardening(): Promise<void> {
  const empty = await readCollaborationOperationIdempotencyKey(
    new NextRequest('http://localhost/api/files/collaboration/operations/test/reject', { method: 'POST' }),
  );
  assert.equal(empty.response?.status, 400, 'an empty collaboration action body must return HTTP 400');

  const malformed = await readCollaborationOperationIdempotencyKey(
    new NextRequest('http://localhost/api/files/collaboration/operations/test/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotencyKey":',
    }),
  );
  assert.equal(malformed.response?.status, 400, 'truncated JSON must return HTTP 400 instead of throwing');

  const missing = await readCollaborationOperationIdempotencyKey(
    new NextRequest('http://localhost/api/files/collaboration/operations/test/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(missing.response?.status, 400, 'a missing idempotency key must return HTTP 400');

  const valid = await readCollaborationOperationIdempotencyKey(
    new NextRequest('http://localhost/api/files/collaboration/operations/test/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"idempotencyKey":"  operation-key  "}',
    }),
  );
  assert.equal(valid.response, null);
  assert.equal(valid.idempotencyKey, 'operation-key');
}

async function assertCheckpointConfirmationCompensation(): Promise<void> {
  let rollbackCount = 0;
  await assert.rejects(
    confirmCheckpointMaterialization({
      materialize: async () => ({
        canonicalContent: 'new checkpoint',
        serializedContent: 'new checkpoint',
        result: 'write-result',
        rollback: async () => { rollbackCount += 1; },
      }),
      confirm: async () => { throw new Error('database confirmation failed'); },
    }),
    /database confirmation failed/u,
  );
  assert.equal(rollbackCount, 1, 'a failed database confirmation must roll back the file projection once');

  const confirmed = await confirmCheckpointMaterialization({
    materialize: async () => ({
      canonicalContent: 'confirmed checkpoint',
      serializedContent: 'confirmed checkpoint',
      result: 'write-result',
      rollback: async () => { rollbackCount += 1; },
    }),
    confirm: async (materialized) => materialized.result,
  });
  assert.equal(confirmed, 'write-result');
  assert.equal(rollbackCount, 1, 'a confirmed database checkpoint must not roll back its file projection');

  const expected = {
    expectedSequence: 4,
    expectedCanonicalHash: 'canonical-4',
    expectedSerializedHash: 'serialized-4',
  };
  assert.equal(checkpointCommitRecoveryDecision({
    ...expected,
    checkpointSequence: 4,
    canonicalHash: 'canonical-4',
    serializedHash: 'serialized-4',
  }), 'committed', 'a lost acknowledgment must keep the file when the exact checkpoint committed');
  assert.equal(checkpointCommitRecoveryDecision({
    ...expected,
    checkpointSequence: 5,
    canonicalHash: 'canonical-5',
    serializedHash: 'serialized-5',
  }), 'superseded', 'a later checkpoint must never be overwritten by compensation');
  assert.equal(checkpointCommitRecoveryDecision({
    ...expected,
    checkpointSequence: 3,
    canonicalHash: 'canonical-3',
    serializedHash: 'serialized-3',
  }), 'rollback', 'an uncommitted checkpoint must restore the previous file');
  assert.equal(checkpointCommitRecoveryDecision({
    ...expected,
    checkpointSequence: 4,
    canonicalHash: 'unexpected',
    serializedHash: 'serialized-4',
  }), 'degraded', 'same-sequence hash divergence must be surfaced instead of overwritten');
}

void Promise.all([
  assertOperationBodyHardening(),
  assertCheckpointConfirmationCompensation(),
])
  .then(() => console.log('file-collaboration-hardening-test: ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
