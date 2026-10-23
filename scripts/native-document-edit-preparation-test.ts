import assert from 'node:assert/strict';
import { Y } from '../app/lib/collaboration/server-runtime';
import type * as YTypes from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createPlainTextYDoc, createRichMarkdownYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectNativeDocument } from '../app/lib/collaboration/document-snapshot';
import { applyAgentBlockTargets, applyAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { documentVersionV1, type DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';
import { assertNativeDocumentEditPrecondition, prepareNativeDocumentEditInDocument,
  validateNativeDocumentEditCandidate } from '../app/lib/collaboration/native-document-edit-preparation';
import { DocumentEditError, decodeDocumentEditRequestV1, decodeDocumentEditPatchV1,
  documentEditRequestFingerprintV1 } from '../app/lib/documents/edit-contracts';

// Pure synchronous codec/Y.Doc/target-writer regressions only. No principal,
// database, network, lifecycle lease, mutation receipt or durability simulation.
type Representation = DocumentVersionIdentityV1['representation'];
const representations: readonly Representation[] = ['plain_text', 'tiptap_xml', 'tiptap_blocks'];
const origin = { actorType: 'agent', actorId: 'mechanical-agent', initiatedByUserId: 'mechanical-user', operationId: 'mechanical-operation' } as const;
function identity(representation: Representation): DocumentVersionIdentityV1 {
  return { workspaceId: 'mechanical-workspace', organizationId: 'mechanical-org', documentId: 'mechanical-document',
    lineageId: 'mechanical-lineage', lifecycleGeneration: 3, representation, schemaVersion: 1 };
}
function docFor(representation: Representation, text = 'Target and stable tail.'): YTypes.Doc {
  return representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
}
function copy(source: YTypes.Doc | Uint8Array): YTypes.Doc {
  const result = new Y.Doc({ gc: false });
  try { Y.applyUpdate(result, source instanceof Uint8Array ? source : Y.encodeStateAsUpdate(source)); return result; }
  catch (error) { result.destroy(); throw error; }
}
function observed(doc: YTypes.Doc, scope: DocumentVersionIdentityV1) {
  const native = inspectNativeDocument(doc, scope.representation);
  return { native, version: documentVersionV1(scope, native.version.stateProof) };
}
function assertSourceUnchanged(source: YTypes.Doc, before: Uint8Array): void {
  assert.deepEqual(Y.encodeStateAsUpdate(source), before, 'Preparation and rejected guards preserve the original exact Yjs source bytes.');
}
function deepFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value));
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    assert(Object.hasOwn(descriptor, 'value'), 'Decoded trees contain data fields only.'); deepFrozen(descriptor.value);
  }
}
let groups = 0;
function check(name: string, operation: () => void): void {
  operation(); groups++; console.log('PASS native edit preparation:', name);
}

function editError(code: string, status?: number): (error: unknown) => boolean {
  return error => { assert(error instanceof DocumentEditError); assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status); return true; };
}
function textPatch(oldText: string, newText: string, expectedOccurrences?: number, blockId?: string) {
  return decodeDocumentEditPatchV1({ kind: 'native_text_replace', edits: [{ oldText, newText,
    ...(expectedOccurrences === undefined ? {} : { expectedOccurrences }) }], ...(blockId ? { blockId } : {}) });
}
function prepare(doc: YTypes.Doc, scope: DocumentVersionIdentityV1, patch: unknown) {
  const before = Y.encodeStateAsUpdate(doc), roots = new Map(doc.share), proof = observedProof(doc);
  const currentVersion = documentVersionV1(scope, proof);
  let sourceUpdates = 0; const onUpdate = () => { sourceUpdates++; }; doc.on('update', onUpdate);
  let prepared: ReturnType<typeof prepareNativeDocumentEditInDocument>;
  try { prepared = prepareNativeDocumentEditInDocument({ doc, identity: scope, expectedVersion: currentVersion,
    patch: decodeDocumentEditPatchV1(patch), groupId: 'mechanical-group' }); }
  finally { doc.off('update', onUpdate); }
  assert.equal(sourceUpdates, 0); assert.deepEqual([...doc.share.keys()], [...roots.keys()]);
  for (const [name, type] of roots) assert.equal(doc.share.get(name), type, 'Preparation preserves every actual source root type.');
  assertSourceUnchanged(doc, before);
  assert.deepEqual(prepared.identity, scope); assert.equal(prepared.expectedVersion, currentVersion);
  assert.equal(prepared.beforeVersion, currentVersion); assert.equal(prepared.beforeStateProof, proof);
  const beforeDoc = copy(prepared.nativeBeforeUpdate); let afterDoc: YTypes.Doc | undefined;
  try {
    afterDoc = copy(prepared.nativeAfterUpdate);
    assert.equal(observed(beforeDoc, scope).native.version.stateProof, prepared.beforeStateProof);
    const after = observed(afterDoc, scope);
    assert.equal(after.native.version.stateProof, prepared.afterStateProof); assert.equal(after.version, prepared.afterVersion);
    assert.equal(validateNativeDocumentEditCandidate(afterDoc, scope.representation), null);
    assert.equal(prepared.noChange, prepared.beforeStateProof === prepared.afterStateProof);
    if (!prepared.noChange) {
      const candidate = copy(prepared.nativeBeforeUpdate);
      try {
        const options = { doc: candidate, targets: prepared.targets, origin,
          validateClone: (value: YTypes.Doc) => validateNativeDocumentEditCandidate(value, scope.representation) };
        const actual = prepared.targets[0]?.kind === 'block_edit' ? applyAgentBlockTargets(options) : applyAgentTextTargets(options);
        assert.equal(actual.status, 'applied_to_ydoc'); assert.deepEqual(actual.conflicts, []);
        assert.equal(actual.appliedTargetIds.length, prepared.targets.length);
        // Independent text-writer replays may allocate different client clocks;
        // compare authoritative native content, not invented identical clocks.
        assert.deepEqual(observed(candidate, scope).native.content, after.native.content);
      } finally { candidate.destroy(); }
    }
  } finally { beforeDoc.destroy(); afterDoc?.destroy(); }
  assertSourceUnchanged(doc, before); return prepared;
}
function request(extra: Record<string, unknown> = {}) {
  return { apiVersion: 1, workspaceId: 'mechanical-workspace', documentId: 'mechanical-document',
    expectedVersion: `canvas-document-v1:${'a'.repeat(64)}`, idempotencyKey: 'mechanical-key',
    patch: { kind: 'native_text_replace', edits: [{ oldText: 'Target', newText: 'Changed' }] }, ...extra };
}
function block(doc: YTypes.Doc, text: string, type = 'paragraph') {
  const found = readAgentBlockStructure(doc).find(value => value.type === type && value.text === text);
  assert(found, `Missing native ${type} fixture.`); return found;
}

export function nativeDocumentEditPreparationTest(): void {
  check('Plain/XML/Blocks use actual existing targets and independently proven before/after binaries', () => {
    for (const representation of representations) {
      const source = docFor(representation, 'Target 😀 and stable tail.'), scope = identity(representation);
      try {
        const prepared = prepare(source, scope, textPatch('Target', 'Changed 🦊'));
        assert.equal(prepared.noChange, false); assert.equal(prepared.targets.length, 1);
        assert.notEqual(prepared.afterVersion, prepared.beforeVersion);
        const after = copy(prepared.nativeAfterUpdate);
        try { assert.match(JSON.stringify(observed(after, scope).native.content), /Changed 🦊/u);
          assert.match(JSON.stringify(observed(after, scope).native.content), /stable tail/u); }
        finally { after.destroy(); }
      } finally { source.destroy(); }
    }
  });
  check('schema-valid native XML/Blocks remain editable while Markdown loses table widths', () => {
    for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
      const source = nativeTableWidthFixture(representation), scope = identity(representation);
      try {
        assert.equal(validateRichMarkdownYDoc(source).code, 'roundtrip_unstable');
        assert.equal(validateNativeDocumentEditCandidate(source, representation), null);
        const prepared = prepare(source, scope, textPatch('Target', 'Changed'));
        const after = copy(prepared.nativeAfterUpdate);
        try { assert.equal(validateRichMarkdownYDoc(after).code, 'roundtrip_unstable');
          const native = JSON.stringify(observed(after, scope).native.content);
          assert.match(native, /"colwidth":\[120\]/u); assert.match(native, /Changed/u); assert.match(native, /target\.md/u); }
        finally { after.destroy(); }
      } finally { source.destroy(); }
    }
  });
  check('full CAS includes deletions, same-visible-text history and all seven native identity fields', () => {
    const source = createPlainTextYDoc('ABCDE'), scope = identity('plain_text');
    try {
      const initial = observed(source, scope), vector = Y.encodeStateVector(source);
      source.getText('content').delete(1, 2);
      assert.deepEqual(Y.encodeStateVector(source), vector, 'Deletion alone does not advance the state vector.');
      assert.notEqual(observed(source, scope).version, initial.version);
      const deleted = Y.encodeStateAsUpdate(source);
      assert.throws(() => assertNativeDocumentEditPrecondition({ doc: source, identity: scope, expectedVersion: initial.version }),
        editError('DOCUMENT_VERSION_CONFLICT', 409)); assertSourceUnchanged(source, deleted);
      source.getText('content').insert(1, 'BC'); assert.equal(source.getText('content').toString(), 'ABCDE');
      assert.notEqual(observed(source, scope).version, initial.version);
      assert.throws(() => assertNativeDocumentEditPrecondition({ doc: source, identity: scope, expectedVersion: initial.version }),
        editError('DOCUMENT_VERSION_CONFLICT', 409));
      const current = observed(source, scope), before = Y.encodeStateAsUpdate(source);
      const alternatives: readonly DocumentVersionIdentityV1[] = [
        { ...scope, workspaceId: 'other-workspace' }, { ...scope, organizationId: 'other-org' },
        { ...scope, documentId: 'other-document' }, { ...scope, lineageId: 'other-lineage' },
        { ...scope, lifecycleGeneration: 4 }, { ...scope, representation: 'tiptap_xml' }, { ...scope, schemaVersion: 2 },
      ];
      for (const changed of alternatives) {
        assert.notEqual(documentVersionV1(changed, current.native.version.stateProof), current.version);
        assert.throws(() => assertNativeDocumentEditPrecondition({ doc: source, identity: changed, expectedVersion: current.version }),
          editError('DOCUMENT_VERSION_CONFLICT', 409)); assertSourceUnchanged(source, before);
      }
    } finally { source.destroy(); }
  });
  check('a genuine peer update between preparation and final guard cannot mutate the observed source', () => {
    const source = createPlainTextYDoc('Target and tail'), scope = identity('plain_text'), peer = copy(source);
    try {
      const prepared = prepare(source, scope, textPatch('Target', 'Changed'));
      peer.getText('content').insert(peer.getText('content').length, ' human');
      Y.applyUpdate(source, Y.encodeStateAsUpdate(peer)); const changed = Y.encodeStateAsUpdate(source);
      let enteredWriter = 0;
      assert.throws(() => {
        assertNativeDocumentEditPrecondition({ doc: source, identity: scope, expectedVersion: prepared.beforeVersion });
        enteredWriter++;
        applyAgentTextTargets({ doc: source, targets: prepared.targets, origin });
      }, editError('DOCUMENT_VERSION_CONFLICT', 409));
      assert.equal(enteredWriter, 0); assert.equal(source.getText('content').toString(), 'Target and tail human');
      assertSourceUnchanged(source, changed);
    } finally { source.destroy(); peer.destroy(); }
  });
  check('Unicode boundaries, overlapping targets, target budgets and unknown native schema reject atomically', () => {
    const rejected = (source: YTypes.Doc, patch: unknown, code: string) => {
      const scope = identity('plain_text'), before = Y.encodeStateAsUpdate(source);
      assert.throws(() => prepareNativeDocumentEditInDocument({ doc: source, identity: scope,
        expectedVersion: observed(source, scope).version, patch: decodeDocumentEditPatchV1(patch), groupId: 'mechanical-group' }),
      editError(code, 409)); assertSourceUnchanged(source, before);
    };
    const combining = createPlainTextYDoc('e\u0301 👩‍👩‍👧‍👦'), overlap = createPlainTextYDoc('ABCDE');
    try {
      rejected(combining, textPatch('\u0301', 'x'), 'DOCUMENT_EDIT_CONFLICT');
      rejected(overlap, { kind: 'native_text_replace', edits: [{ oldText: 'ABC', newText: 'X' },
        { oldText: 'BCD', newText: 'Y' }] }, 'DOCUMENT_EDIT_CONFLICT');
      const accepted = prepare(combining, identity('plain_text'), textPatch('👩‍👩‍👧‍👦', '🦊'));
      assert.equal(accepted.noChange, false);
      const maximum = createPlainTextYDoc('x'.repeat(32));
      try { const all = prepare(maximum, identity('plain_text'), textPatch('x', '', 32));
        assert.equal(all.targets.length, 32); const emptied = copy(all.nativeAfterUpdate);
        try { assert.equal(emptied.getText('content').toString(), ''); } finally { emptied.destroy(); } }
      finally { maximum.destroy(); }
      assert.throws(() => decodeDocumentEditPatchV1({ kind: 'native_text_replace', edits: [{ oldText: 'x', newText: '', expectedOccurrences: 33 }] }),
        editError('DOCUMENT_TOO_LARGE', 413));
      assert.throws(() => decodeDocumentEditPatchV1({ kind: 'native_text_replace', edits: [{ oldText: 'x', newText: 'x'.repeat(512 * 1024) }] }),
        editError('DOCUMENT_TOO_LARGE', 413));
      for (const invalid of ['\ud800', '\udc00']) assert.throws(() => decodeDocumentEditPatchV1({ kind: 'native_text_replace',
        edits: [{ oldText: 'x', newText: invalid }] }), editError('INVALID_REQUEST', 400));
    } finally { combining.destroy(); overlap.destroy(); }
    const composing = createPlainTextYDoc('Target and tail'), awareness = new Awareness(composing);
    try {
      Object.defineProperty(composing, 'awareness', { value: awareness });
      awareness.setLocalState({ canvas: { composition: { textName: 'content', from: 0, to: 6 } } });
      const state = awareness.getLocalState();
      rejected(composing, textPatch('Target', 'Changed'), 'DOCUMENT_EDIT_CONFLICT');
      assert.equal(awareness.getLocalState(), state, 'The actual source IME awareness remains untouched.');
    } finally { awareness.destroy(); composing.destroy(); }
    for (const representation of representations) {
      const source = docFor(representation), scope = identity(representation);
      try {
        source.getMap('unknown_native_root').set('unrecognized', true);
        const before = Y.encodeStateAsUpdate(source), expectedVersion = documentVersionV1(scope,
          observedProof(source));
        assert.equal(validateNativeDocumentEditCandidate(source, representation), 'schema_invalid');
        assert.throws(() => prepareNativeDocumentEditInDocument({ doc: source, identity: scope, expectedVersion,
          patch: textPatch('Target', 'Changed'), groupId: 'mechanical-group' }), editError('DOCUMENT_STATE_INVALID', 409));
        assertSourceUnchanged(source, before);
      } finally { source.destroy(); }
    }
  });
  check('native block text, attributes, formatting, move, insert, delete and table targets use existing writers', () => {
    const source = createRichMarkdownYDoc('# Heading\n\nAlpha\n\nBeta\n\n| Header |\n| --- |\n| Cell |', 'tiptap_blocks');
    const scope = identity('tiptap_blocks');
    try {
      const heading = block(source, 'Heading', 'heading'), alpha = block(source, 'Alpha'), beta = block(source, 'Beta');
      const table = readAgentBlockStructure(source).find(value => value.type === 'table');
      const cell = readAgentBlockStructure(source).find(value => value.type === 'tableCell'); assert(table && cell);
      const scoped = prepare(source, scope, textPatch('Alpha', 'Changed', 1, alpha.id));
      const scopedDoc = copy(scoped.nativeAfterUpdate);
      try { assert.equal(block(scopedDoc, 'Changed').id, alpha.id); assert.equal(block(scopedDoc, 'Beta').id, beta.id); }
      finally { scopedDoc.destroy(); }
      const operations = [
        { kind: 'format_block', blockId: heading.id, beforeAttrs: { level: 1 }, afterAttrs: { level: 2 } },
        { kind: 'format_text', blockId: alpha.id, subtreeHash: alpha.subtreeHash, from: 0, to: 5, mark: 'bold', enabled: true },
        { kind: 'move_block', blockId: alpha.id, placementHash: alpha.placementHash, parentId: null, beforeId: null },
        { kind: 'insert_blocks', parentId: null, beforeId: beta.id,
          blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inserted' }] }] },
        { kind: 'delete_block', blockId: beta.id, subtreeHash: beta.subtreeHash },
        { kind: 'table_operation', cellId: cell.id, subtreeHash: table.subtreeHash, action: 'addRowAfter' },
      ];
      for (const operation of operations) {
        const prepared = prepare(source, scope, { kind: 'native_blocks', operations: [operation] });
        assert.equal(prepared.noChange, false); assert.equal(prepared.targets.length, 1);
        assert.equal(prepared.targets[0].kind, 'block_edit');
        const after = copy(prepared.nativeAfterUpdate);
        try {
          const entries = readAgentBlockStructure(after);
          if (operation.kind === 'format_block') assert.equal(entries.find(value => value.id === heading.id)?.attrs.level, 2);
          if (operation.kind === 'format_text') assert.match(JSON.stringify(observed(after, scope).native.content), /"bold"/u);
          if (operation.kind === 'move_block') assert.equal(entries.find(value => value.id === alpha.id)?.beforeId, null);
          if (operation.kind === 'insert_blocks') assert(entries.some(value => value.text === 'Inserted'));
          if (operation.kind === 'delete_block') assert(!entries.some(value => value.id === beta.id));
          if (operation.kind === 'table_operation') assert.equal(entries.filter(value => value.type === 'tableRow').length, 3);
          assert(entries.some(value => value.id === heading.id));
        } finally { after.destroy(); }
      }
      assert.throws(() => prepareNativeDocumentEditInDocument({ doc: source, identity: scope,
        expectedVersion: observed(source, scope).version, patch: textPatch('Alpha', 'Changed', 1, beta.id), groupId: 'mechanical-group' }),
      editError('DOCUMENT_EDIT_CONFLICT', 409));
    } finally { source.destroy(); }
  });
  check('no-op preparation creates no source change and keeps full before/after evidence equal', () => {
    for (const representation of representations) {
      const source = docFor(representation), scope = identity(representation);
      try { const prepared = prepare(source, scope, textPatch('Target', 'Target'));
        assert.equal(prepared.noChange, true); assert.equal(prepared.beforeVersion, prepared.afterVersion);
        assert.deepEqual(prepared.nativeBeforeUpdate, prepared.nativeAfterUpdate); }
      finally { source.destroy(); }
    }
  });
  check('strict requests detach/freeze and canonicalize fingerprints without executing foreign behavior', () => {
    const input = request(), decoded = decodeDocumentEditRequestV1(input); deepFrozen(decoded);
    assert.notEqual(decoded, input); assert.equal(decoded.patch.kind, 'native_text_replace');
    assert.match(documentEditRequestFingerprintV1(input), /^[a-f0-9]{64}$/u);
    const equivalent = request({ idempotencyKey: 'new-retry-key', patch: { edits: [{ expectedOccurrences: 1,
      newText: 'Changed', oldText: 'Target' }], kind: 'native_text_replace' } });
    assert.equal(documentEditRequestFingerprintV1(equivalent), documentEditRequestFingerprintV1(input));
    for (const changed of [{ documentId: 'other-document' }, { workspaceId: 'other-workspace' },
      { expectedVersion: `canvas-document-v1:${'b'.repeat(64)}` },
      { patch: { kind: 'native_text_replace', edits: [{ oldText: 'Target', newText: 'Different' }] } }]) {
      assert.notEqual(documentEditRequestFingerprintV1(request(changed)), documentEditRequestFingerprintV1(input));
    }
    input.patch.edits[0].newText = 'Caller mutation';
    assert(decoded.patch.kind === 'native_text_replace'); assert.equal(decoded.patch.edits[0].newText, 'Changed');
    const blocks = request({ patch: { kind: 'native_blocks', operations: [{ kind: 'insert_blocks', parentId: null,
      beforeId: null, blocks: [{ type: 'heading', attrs: { id: 'native-heading', level: 2 },
        content: [{ type: 'text', text: 'Inserted' }] }] }] } });
    const reordered = request({ idempotencyKey: 'different', patch: { operations: [{ blocks: [{
      content: [{ text: 'Inserted', type: 'text' }], attrs: { level: 2, id: 'native-heading' }, type: 'heading' }],
      beforeId: null, parentId: null, kind: 'insert_blocks' }], kind: 'native_blocks' } });
    assert.equal(documentEditRequestFingerprintV1(blocks), documentEditRequestFingerprintV1(reordered));
    deepFrozen(decodeDocumentEditRequestV1(blocks));
    for (const extra of ['path', 'actorId', 'sessionId', 'targets', 'yjsUpdate', 'fullStateProof', 'operationId']) {
      assert.throws(() => decodeDocumentEditRequestV1({ ...request(), [extra]: 'forged' }), editError('INVALID_REQUEST', 400));
    }
    assert.throws(() => decodeDocumentEditRequestV1(Object.defineProperty(request(), 'hidden', { value: true })), editError('INVALID_REQUEST', 400));
    assert.throws(() => decodeDocumentEditRequestV1({ ...request(), [Symbol('foreign')]: true }), editError('INVALID_REQUEST', 400));
    const badPatch = { kind: 'native_text_replace', edits: [{ oldText: 'Target', newText: 'Changed', replaceAll: true }] };
    assert.throws(() => decodeDocumentEditRequestV1(request({ patch: badPatch })), editError('INVALID_REQUEST', 400));
    for (const bad of [undefined, null, [], { ...request(), apiVersion: 2 },
      request({ patch: { kind: 'native_blocks', operations: [{ kind: 'insert_blocks', parentId: null, beforeId: null,
        blocks: [{ type: 'paragraph' }], updateBase64: 'forged' }] } })]) {
      assert.throws(() => decodeDocumentEditRequestV1(bad), editError('INVALID_REQUEST', 400));
    }
    const formatWith = (afterAttrs: unknown) => request({ patch: { kind: 'native_blocks', operations: [{
      kind: 'format_block', blockId: 'native-heading', beforeAttrs: {}, afterAttrs }] } });
    let nested: unknown = null;
    for (let index = 0; index < 34; index++) nested = { child: nested };
    for (const value of [formatWith({ nested }), formatWith({ nodes: Array.from({ length: 16_385 }, () => 0) }),
      request({ patch: { kind: 'native_text_replace', edits: Array.from({ length: 33 }, () => ({ oldText: 'x', newText: 'y' })) } })]) {
      assert.throws(() => decodeDocumentEditRequestV1(value), editError('DOCUMENT_TOO_LARGE', 413));
    }
    let calls = 0;
    const getter = Object.defineProperty(request(), 'patch', { enumerable: true, get() { calls++; throw new Error('Foreign getter ran.'); } });
    const nestedGetter = request({ patch: { kind: 'native_text_replace', edits: [Object.defineProperty({ oldText: 'Target' }, 'newText',
      { enumerable: true, get() { calls++; throw new Error('Nested getter ran.'); } })] } });
    const indexGetter: unknown[] = []; Object.defineProperty(indexGetter, 0, { enumerable: true,
      get() { calls++; throw new Error('Foreign array getter ran.'); } });
    const sparse = new Array(1);
    const trapped = new Proxy(request(), { get() { calls++; throw new Error('Proxy get ran.'); },
      ownKeys() { calls++; throw new Error('Proxy keys ran.'); }, getPrototypeOf() { calls++; throw new Error('Proxy prototype ran.'); },
      getOwnPropertyDescriptor() { calls++; throw new Error('Proxy descriptor ran.'); } });
    const revoked = Proxy.revocable(request(), {}); revoked.revoke();
    const toJson = Object.assign(request(), { toJSON() { calls++; throw new Error('Foreign toJSON ran.'); } });
    for (const value of [getter, nestedGetter, trapped, revoked.proxy, toJson,
      request({ patch: { kind: 'native_text_replace', edits: indexGetter } }), request({ patch: { kind: 'native_text_replace', edits: sparse } })]) {
      assert.throws(() => decodeDocumentEditRequestV1(value), editError('INVALID_REQUEST', 400)); assert.equal(calls, 0);
    }
    const ownMap = [{ oldText: 'Target', newText: 'Changed' }];
    Object.defineProperty(ownMap, 'map', { value: () => { calls++; throw new Error('Foreign array method ran.'); }, enumerable: true });
    assert.throws(() => decodeDocumentEditRequestV1(request({ patch: { kind: 'native_text_replace', edits: ownMap } })), editError('INVALID_REQUEST', 400));
    assert.equal(calls, 0);
  });
  assert.equal(groups, 8);
  console.log(JSON.stringify({ suite: 'native-document-edit-preparation', groups,
    evidence: 'pure_synchronous_codec_and_actual_yjs_target_writers_only' }));
}

function observedProof(doc: YTypes.Doc): string {
  const proof = collaborationStateProof(doc, Y); assert(proof); return proof;
}
try { nativeDocumentEditPreparationTest(); }
catch (error) { console.error(error); process.exitCode = 1; }
