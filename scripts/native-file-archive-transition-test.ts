import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { inspectArchivedNativeSnapshot } from '../app/lib/collaboration/archived-native-snapshot';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { isCollaborationStateQuarantined, COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions,
  validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { NativeFileArchiveTransitionError, prepareNativeFileArchiveTransition,
  NativeFileRestoreTransitionError, prepareNativeFileRestoreTransition, captureNativeFileArchiveRestoreData,
  type NativeFileArchiveExpected, type NativeFileArchiveTransition,
  type NativeFileRestoreTransition } from '../app/lib/collaboration/native-file-archive-transition';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const selection = { trashEntryId: 'original-trash-D1',archivedAt: 300 };
function stateFor(doc: InstanceType<typeof Y.Doc>, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'original-D1',workspaceId: 'archive-workspace',organizationId: null,path: ' literal name .md',
    representation,lifecycleGeneration: 4,schemaVersion: COLLABORATION_SCHEMA_VERSION,
    yjsState: Y.encodeStateAsUpdate(doc),stateVector: Y.encodeStateVector(doc),documentSequence: 7,persistedAt: 100,
    checkpointSequence: 7,checkpointedAt: 100,canonicalHash: 'a'.repeat(64),serializedHash: 'b'.repeat(64),
    newlineStyle: 'crlf',hasBom: true,degraded: false,status: 'active',projectionFinalized: true };
}
function expectedFor(state: PersistedCollaborationState): NativeFileArchiveExpected {
  return { documentId: state.documentId,lineageId: 'original-L1',workspaceId: state.workspaceId,organizationId: state.organizationId,
    path: state.path,representation: state.representation,schemaVersion: state.schemaVersion,lifecycleGeneration: state.lifecycleGeneration,
    registryStateVersion: Math.min(6,state.documentSequence),documentSequence: state.documentSequence,persistedAt: state.persistedAt,
    stateProof: authoritativeNativeCollaborationSnapshot(state).version.stateProof,
    binaryHash: digest(state.yjsState),vectorHash: digest(state.stateVector) };
}
function archivedState(state: PersistedCollaborationState, transition: NativeFileArchiveTransition): PersistedCollaborationState {
  const { projectionError: _previousError,...unchanged } = state;
  return { ...unchanged,status: transition.writes.state.status,lifecycleGeneration: transition.writes.state.lifecycleGeneration,
    checkpointSequence: transition.writes.state.checkpointSequence,checkpointedAt: transition.writes.state.checkpointedAt,
    canonicalHash: transition.writes.state.canonicalHash,serializedHash: transition.writes.state.serializedHash,
    degraded: transition.writes.state.degraded,projectionFinalized: transition.writes.projection.finalized };
}
function assertFrozen(value: unknown): void {
  if (value && typeof value === 'object') {
    assert(Object.isFrozen(value));
    assert(!(value instanceof Uint8Array));
    for (const child of Object.values(value)) assertFrozen(child);
  }
}

for (const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const) {
  test(`${representation}: archive keeps exact native bytes, vector, deletion proof, clocks and byte profile`, () => {
    const doc = representation === 'plain_text' ? createPlainTextYDoc('Keep\t😀\r\n')
      : createRichMarkdownYDoc('First **marked** paragraph.\n\n- List item\n\n> [!note] Keep\n> Native content',representation);
    try {
      const state = stateFor(doc,representation), expected = expectedFor(state), before = structuredClone(state);
      const transition = prepareNativeFileArchiveTransition(state,expected,selection);
      assert.deepEqual(state,before,'Pure preparation must not change caller data or encode a replacement document.');
      assert.deepEqual(transition.before.clock,transition.after.clock);
      assert.equal(transition.after.identity.documentId,'original-D1');
      assert.equal(transition.after.identity.lineageId,'original-L1');
      assert.equal(transition.after.identity.path,state.path);
      assert.equal(transition.after.identity.lifecycleGeneration,5);
      assert.equal(transition.before.registryStateVersion,6); assert.equal(transition.after.registryStateVersion,0);
      assert.deepEqual(transition.before.byteProfile,{ newlineStyle: 'crlf',hasBom: true });
      assert.equal(transition.cas.registry.documentId,'original-D1'); assert.equal(transition.cas.registry.lineageId,'original-L1');
      assert.equal(transition.cas.state.lifecycleGeneration,4); assert.equal(transition.cas.lineage.lineageId,'original-L1');
      assert.equal(transition.writes.lineage.trashEntryId,selection.trashEntryId);
      assert.equal(transition.writes.lineage.archivedAt,selection.archivedAt);
      assert.deepEqual(transition.writes.projection,{ documentId: 'original-D1',lifecycleGeneration: 5,projectedSequence: 7,
        finalized: false,revisionId: null,canonicalHash: null,serializedHash: null,updatedAt: 300 });
      const archived = archivedState(state,transition), snapshot = inspectArchivedNativeSnapshot(archived);
      assert.deepEqual(snapshot.content,authoritativeNativeCollaborationSnapshot(state).content);
      assert.equal(snapshot.version.stateProof,expected.stateProof);
      assert.equal(snapshot.version.stateVector,Buffer.from(state.stateVector).toString('base64'));
      assert.equal(snapshot.version.documentSequence,7); assert.equal(snapshot.version.persistedAt,100);
      assert.equal(archived.yjsState,state.yjsState); assert.equal(archived.stateVector,state.stateVector);
      assert.equal(isCollaborationStateQuarantined(archived),false);
      assertFrozen(transition); assert.deepEqual(JSON.parse(JSON.stringify(transition)),transition);
      assert.deepEqual(prepareNativeFileArchiveTransition(state,expected,selection),transition,'No ambient time or random identity enters the result.');
    } finally { doc.destroy(); }
  });
  test(`${representation}: initialized empty sequence-zero archive remains valid`, () => {
    const doc = representation === 'plain_text' ? createPlainTextYDoc('') : createRichMarkdownYDoc('',representation);
    try {
      const state = { ...stateFor(doc,representation),documentSequence: 0,checkpointSequence: 0,checkpointedAt: null };
      const transition = prepareNativeFileArchiveTransition(state,expectedFor(state),selection);
      const archived = inspectArchivedNativeSnapshot(archivedState(state,transition));
      assert.equal(archived.version.documentSequence,0); assert.equal(archived.lifecycleGeneration,5);
    } finally { doc.destroy(); }
  });
}

test('registry version ahead of native sequence is rejected before archive', () => {
  const doc = createPlainTextYDoc('Original');
  try {
    const state = stateFor(doc,'plain_text'), expected = expectedFor(state);
    assert.throws(() => prepareNativeFileArchiveTransition(state,{ ...expected,registryStateVersion: state.documentSequence+1 },selection),
      error => error instanceof NativeFileArchiveTransitionError && error.code === 'NATIVE_FILE_ARCHIVE_INVALID');
  } finally { doc.destroy(); }
});

test('legal native-only table widths survive archive without Markdown export', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |','tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc,getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell','tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth',[120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code,'roundtrip_unstable');
    const state = stateFor(doc,'tiptap_blocks'), expected = expectedFor(state);
    state.projectionError = { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE',sequence: 7,permanent: false,phase: 'serialize' };
    const before = structuredClone(state), transition = prepareNativeFileArchiveTransition(state,expected,selection);
    assert.deepEqual(state,before);
    assert.match(JSON.stringify(inspectArchivedNativeSnapshot(archivedState(state,transition)).content),/"colwidth":\[120\]/u);
    assert.deepEqual(transition.before.diagnostics.projectionError,state.projectionError);
    assert.equal(transition.writes.state.projectionError,null);
  } finally { doc.destroy(); }
});

test('empty XML with only frontmatter metadata keeps its genuine native snapshot', () => {
  const doc = createRichMarkdownYDoc('---\ntitle: Metadata only\n---\n','tiptap_xml');
  try {
    const state = { ...stateFor(doc,'tiptap_xml'),documentSequence: 0,checkpointSequence: 0 };
    const transition = prepareNativeFileArchiveTransition(state,expectedFor(state),selection);
    assert.deepEqual(inspectArchivedNativeSnapshot(archivedState(state,transition)).content,authoritativeNativeCollaborationSnapshot(state).content);
  } finally { doc.destroy(); }
});

test('classified storage retry resets only derived diagnostics; genuine archived reader accepts the new generation', () => {
  const doc = createPlainTextYDoc('Durable native content');
  try {
    const state = stateFor(doc,'plain_text'), expected = expectedFor(state);
    state.degraded = true;
    state.projectionError = { code: COLLABORATION_FAILURE_CODES.persistenceFailed,sequence: 7,permanent: false,phase: 'persist' };
    const original = structuredClone(state), transition = prepareNativeFileArchiveTransition(state,expected,selection);
    assert.deepEqual(transition.before.diagnostics,{ degraded: true,projectionError: state.projectionError });
    assert.equal(transition.projectionDisposition,'reset_derived_status_for_new_archive_generation');
    assert.equal(transition.writes.state.degraded,false); assert.equal(transition.writes.state.projectionError,null);
    assert.equal(isCollaborationStateQuarantined(archivedState(state,transition)),false);
    const archived = inspectArchivedNativeSnapshot(archivedState(state,transition));
    assert.equal(archived.lifecycleGeneration,5); assert.equal(archived.version.stateProof,expected.stateProof);
    assert.deepEqual(state,original);
  } finally { doc.destroy(); }
});

test('permanent and unclassified degradation are rejected before any reset can be returned', () => {
  const doc = createPlainTextYDoc('Keep');
  try {
    const state = stateFor(doc,'plain_text'), expected = expectedFor(state);
    for (const change of [{ degraded: true },
      { degraded: true,projectionError: { code: 'UNKNOWN_FAILURE',sequence: 7,permanent: false } },
      { degraded: false,projectionError: { code: COLLABORATION_FAILURE_CODES.persistenceFailed,sequence: 7,permanent: true } },
      { degraded: false,projectionError: { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE',sequence: 7,permanent: true } }]) {
      const candidate = { ...state,...change }, before = structuredClone(candidate);
      assert.throws(() => prepareNativeFileArchiveTransition(candidate,expected,selection),/quarantined/u);
      assert.deepEqual(candidate,before);
    }
  } finally { doc.destroy(); }
});

test('original stable identity and every clock/proof are CAS-bound; replacement D2 is never accepted by path', () => {
  const doc = createPlainTextYDoc('Original');
  try {
    const state = stateFor(doc,'plain_text'), expected = expectedFor(state);
    for (const change of [{ documentId: 'replacement-D2' },{ workspaceId: 'other-workspace' },{ organizationId: 'other-org' },
      { path: 'literal name .md' },{ representation: 'tiptap_xml' },{ schemaVersion: 2 },{ lifecycleGeneration: 5 },
      { documentSequence: 8 },{ persistedAt: 101 },{ status: 'archived' }]) {
      assert.throws(() => prepareNativeFileArchiveTransition({ ...state,...change } as PersistedCollaborationState,expected,selection),
        error => error instanceof NativeFileArchiveTransitionError && error.code === 'NATIVE_FILE_ARCHIVE_SOURCE_CHANGED');
    }
    for (const change of [{ binaryHash: '0'.repeat(64) },{ vectorHash: '0'.repeat(64) },
      { stateProof: `yjs-snapshot-sha256-v1:${'0'.repeat(64)}` }]) {
      assert.throws(() => prepareNativeFileArchiveTransition(state,{ ...expected,...change },selection),/SOURCE_CHANGED/u);
    }
    const transition = prepareNativeFileArchiveTransition(state,expected,selection);
    assert.equal(transition.cas.state.documentId,'original-D1'); assert.equal(transition.cas.lineage.lineageId,'original-L1');
    assert.equal(transition.writes.projection.documentId,'original-D1');
    assert(!JSON.stringify(transition).includes('replacement-D2'));
  } finally { doc.destroy(); }
});

test('deletion-sensitive proof rejects a deleted body even when vector and claimed binary hash have been refreshed', () => {
  const doc = createPlainTextYDoc('Delete first');
  try {
    const old = stateFor(doc,'plain_text'), expected = expectedFor(old);
    doc.getText('content').delete(0,1);
    const next = stateFor(doc,'plain_text');
    assert.equal(digest(next.stateVector),expected.vectorHash);
    assert.throws(() => prepareNativeFileArchiveTransition(next,{ ...expected,binaryHash: digest(next.yjsState) },selection),/SOURCE_CHANGED/u);
  } finally { doc.destroy(); }
});

test('invalid flags, metadata, bounds, overflow and malformed captured inputs never produce archive fields', () => {
  const doc = createPlainTextYDoc('Keep');
  try {
    const state = stateFor(doc,'plain_text'), expected = expectedFor(state);
    for (const change of [{ hasBom: '1' },{ degraded: '0' },{ newlineStyle: 'unknown' },{ checkpointSequence: 8 },
      { checkpointedAt: -1 },{ projectionFinalized: 1 },{ projectionError: { code: 'bad\0code',sequence: 7,permanent: false } },
      { projectionError: { code: 'bad',sequence: 8,permanent: false } },{ projectionError: { code: 'bad',sequence: 7,permanent: '0' } }]) {
      assert.throws(() => prepareNativeFileArchiveTransition({ ...state,...change } as unknown as PersistedCollaborationState,expected,selection),/INVALID/u);
    }
    for (const change of [{ lineageId: '' },{ lifecycleGeneration: Number.MAX_SAFE_INTEGER-1 },{ registryStateVersion: -1 },
      { binaryHash: 'invalid' },{ vectorHash: 'invalid' },{ stateProof: 'invalid' },{ extraField: true }]) {
      assert.throws(() => prepareNativeFileArchiveTransition(state,{ ...expected,...change },selection),/INVALID/u);
    }
    for (const candidate of [{ ...selection,archivedAt: 99 },{ ...selection,trashEntryId: '' },{ ...selection,archivedAt: Infinity },
      { ...selection,extraField: true }]) assert.throws(() => prepareNativeFileArchiveTransition(state,expected,candidate),/INVALID/u);
    let reads = 0;
    const accessor = { ...expected }; Object.defineProperty(accessor,'documentId',{ enumerable: true,get() { reads++; return state.documentId; } });
    assert.throws(() => prepareNativeFileArchiveTransition(state,accessor,selection),/INVALID/u); assert.equal(reads,0);
    assert.throws(() => prepareNativeFileArchiveTransition({ ...state,yjsState: new Uint8Array(16*1024*1024+1) },expected,selection),/TOO_LARGE/u);
    assert.throws(() => prepareNativeFileArchiveTransition({ ...state,stateVector: new Uint8Array(1024*1024+1) },expected,selection),/TOO_LARGE/u);
  } finally { doc.destroy(); }
});

test('strict native inspection rejects mismatched vector, trailing bytes and pending updates', () => {
  const doc = createPlainTextYDoc('base');
  try {
    const state = stateFor(doc,'plain_text'), expected = expectedFor(state), badVector = new Uint8Array([0]);
    assert.throws(() => prepareNativeFileArchiveTransition({ ...state,stateVector: badVector },
      { ...expected,vectorHash: digest(badVector) },selection),/vector/u);
    const suffixed = Uint8Array.from([...state.yjsState,0]);
    assert.throws(() => prepareNativeFileArchiveTransition({ ...state,yjsState: suffixed },{ ...expected,binaryHash: digest(suffixed) },selection),/trailing/u);
    const vector = Y.encodeStateVector(doc); doc.getText('content').insert(4,' dependent');
    const partial = Y.encodeStateAsUpdate(doc,vector);
    doc.getText('content').delete(0,2);
    const pendingDeletion = Y.encodeStateAsUpdate(doc,Y.encodeStateVector(doc));
    for (const update of [partial,pendingDeletion]) {
      assert.throws(() => prepareNativeFileArchiveTransition({ ...state,yjsState: update },{ ...expected,binaryHash: digest(update) },selection),/incomplete/u);
    }
  } finally { doc.destroy(); }
});

for (const variant of ['plain-root','xml-node','xml-mark','block-attribute','block-mark','block-record','block-operation'] as const) {
  test(`strict raw native schema rejects ${variant} with unchanged input bytes`, () => {
    const representation = variant === 'plain-root' ? 'plain_text' : variant.startsWith('xml') ? 'tiptap_xml' : 'tiptap_blocks';
    const doc = representation === 'plain_text' ? createPlainTextYDoc('Keep') : createRichMarkdownYDoc('[Keep](target.md)',representation);
    try {
      if (variant === 'plain-root') doc.getMap('future-root').set('hidden','future-value');
      if (variant === 'xml-node') (doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>).setAttribute('futureAttr','future-value');
      if (variant === 'xml-mark') {
        const paragraph = doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>;
        const text = paragraph.toArray().find(child => child instanceof Y.XmlText) as InstanceType<typeof Y.XmlText>;
        const link = text.toDelta().find((part: { attributes?: Record<string, unknown> }) => part.attributes?.link)?.attributes?.link;
        assert(link); text.format(0,text.length,{ link: { ...link,futureAttr: 'future-value' } });
      }
      if (representation === 'tiptap_blocks') {
        const tree = new CollaborationBlockTree(doc,getSchema(richMarkdownSchemaExtensions())), record = [...tree.records.values()][0];
        if (variant === 'block-attribute') (record.get('attributes') as InstanceType<typeof Y.Map>).set('futureAttr','future-value');
        if (variant === 'block-record') record.set('futureField','future-value');
        if (variant === 'block-mark') {
          const text = (record.get('content') as InstanceType<typeof Y.XmlFragment>).toArray().find(child => child instanceof Y.XmlText) as InstanceType<typeof Y.XmlText>;
          const link = text.toDelta().find((part: { attributes?: Record<string, unknown> }) => part.attributes?.link)?.attributes?.link;
          assert(link); text.format(0,text.length,{ link: { ...link,futureAttr: 'future-value' } });
        }
        if (variant === 'block-operation') {
          tree.move({ blockId: [...tree.records.keys()][0],parentId: null,beforeId: null,operationId: 'archive-test-move' },'archive-test');
          const operation = tree.operations.get('archive-test-move'); assert(operation);
          assert.equal(authoritativeNativeCollaborationSnapshot(stateFor(doc,representation)).source,'persisted_yjs');
          tree.operations.set(operation.id,{ ...operation,futureField: 'future-value' } as unknown as typeof operation);
        }
      }
      const state = stateFor(doc,representation), expected = expectedFor(state), before = structuredClone(state);
      assert.throws(() => prepareNativeFileArchiveTransition(state,expected,selection),/unsupported schema|schema_invalid/u);
      assert.deepEqual(state,before);
    } finally { doc.destroy(); }
  });
}

function restoredState(state: PersistedCollaborationState, transition: NativeFileRestoreTransition): PersistedCollaborationState {
  return { ...state,status: transition.writes.state.status,lifecycleGeneration: transition.writes.state.lifecycleGeneration,
    checkpointSequence: transition.writes.state.checkpointSequence,checkpointedAt: transition.writes.state.checkpointedAt,
    canonicalHash: transition.writes.state.canonicalHash,serializedHash: transition.writes.state.serializedHash,
    degraded: transition.writes.state.degraded,projectionFinalized: transition.writes.projection.finalized };
}

for (const representation of ['plain_text','tiptap_xml','tiptap_blocks'] as const) {
  for (const empty of [false,true]) test(`${representation}: ${empty ? 'empty sequence-zero' : 'nonempty'} original restore preserves native history at G+2`, () => {
    const text = empty ? '' : 'Original **marked** text.\n\n- Keep\n\n> [!note] Note\n> Keep';
    const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text,representation);
    try {
      const active = { ...stateFor(doc,representation),...(empty ? { documentSequence: 0,checkpointSequence: 0,checkpointedAt: null } : {}) };
      const expected = expectedFor(active), archive = prepareNativeFileArchiveTransition(active,expected,selection),
        state = archivedState(active,archive), before = structuredClone(state), receiptBefore = structuredClone(archive);
      const result = prepareNativeFileRestoreTransition(state,expected,archive,{ trashEntryId: selection.trashEntryId,restoredAt: 400 });
      assert.deepEqual(state,before); assert.deepEqual(archive,receiptBefore);
      assert.equal(result.before.status,'archived'); assert.equal(result.before.identity.lifecycleGeneration,5);
      assert.equal(result.after.status,'active'); assert.equal(result.after.identity.lifecycleGeneration,6);
      assert.equal(result.archive.originalIdentity.lifecycleGeneration,4); assert.equal(result.archive.trashEntryId,selection.trashEntryId);
      assert.deepEqual(result.before.clock,result.after.clock); assert.deepEqual(result.after.clock,archive.before.clock);
      assert.equal(result.cas.state.documentId,expected.documentId); assert.equal(result.cas.registry.lineageId,expected.lineageId);
      assert.equal(result.cas.state.status,'archived'); assert.equal(result.cas.state.lifecycleGeneration,5);
      assert.equal(result.cas.lineage.trashEntryId,selection.trashEntryId);
      assert.deepEqual(result.writes.lineage,{ status: 'active',archivedAt: null,trashEntryId: null });
      assert.equal(result.writes.registry.stateVersion,0); assert.equal(result.writes.registry.snapshotRevisionId,null);
      assert.deepEqual(result.byteProfile,{ newlineStyle: 'crlf',hasBom: true });
      assert.deepEqual(result.writes.projection,{ documentId: expected.documentId,lifecycleGeneration: 6,
        projectedSequence: active.documentSequence,revisionId: null,canonicalHash: null,serializedHash: null,finalized: false,updatedAt: 400 });
      const restored = restoredState(state,result), snapshot = authoritativeNativeCollaborationSnapshot(restored);
      assert.equal(restored.yjsState,state.yjsState); assert.equal(restored.stateVector,state.stateVector);
      assert.equal(snapshot.version.stateProof,expected.stateProof); assert.equal(snapshot.version.documentSequence,active.documentSequence);
      assert.equal(snapshot.version.persistedAt,active.persistedAt);
      assert.deepEqual(snapshot.content,authoritativeNativeCollaborationSnapshot(active).content);
      assert.equal(isCollaborationStateQuarantined(restored),false); assert.equal(restored.projectionFinalized,false);
      assertFrozen(result); assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
      assert.deepEqual(prepareNativeFileRestoreTransition(state,expected,archive,{ trashEntryId: selection.trashEntryId,restoredAt: 400 }),result);
    } finally { doc.destroy(); }
  });
}

test('native-only table widths restore without Markdown serialization or new native identity', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| Value |','tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc,getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell','tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth',[120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code,'roundtrip_unstable');
    const active = stateFor(doc,'tiptap_blocks'), expected = expectedFor(active), archive = prepareNativeFileArchiveTransition(active,expected,selection);
    const state = archivedState(active,archive), result = prepareNativeFileRestoreTransition(state,expected,archive,
      { trashEntryId: selection.trashEntryId,restoredAt: 400 });
    const restored = restoredState(state,result);
    assert.match(JSON.stringify(authoritativeNativeCollaborationSnapshot(restored).content),/"colwidth":\[120\]/u);
    assert.equal(digest(restored.yjsState),expected.binaryHash); assert.equal(digest(restored.stateVector),expected.vectorHash);
  } finally { doc.destroy(); }
});

test('metadata-only empty XML and old classified diagnostics remain exact without resurrecting failure', () => {
  const doc = createRichMarkdownYDoc('---\ntitle: Only metadata\n---\n','tiptap_xml');
  try {
    const active = stateFor(doc,'tiptap_xml'), expected = expectedFor(active);
    active.degraded = true; active.projectionError = { code: COLLABORATION_FAILURE_CODES.persistenceFailed,
      sequence: active.documentSequence,permanent: false,phase: 'persist' };
    const archive = prepareNativeFileArchiveTransition(active,expected,selection), state = archivedState(active,archive);
    const result = prepareNativeFileRestoreTransition(state,expected,archive,{ trashEntryId: selection.trashEntryId,restoredAt: 400 });
    assert.equal(result.writes.state.degraded,false); assert.equal(result.writes.state.projectionError,null);
    assert.equal(result.projectionDisposition,'reset_derived_status_for_new_restore_generation');
    const snapshot = authoritativeNativeCollaborationSnapshot(restoredState(state,result));
    assert.deepEqual(snapshot.content,authoritativeNativeCollaborationSnapshot(active).content);
    assert.equal(snapshot.version.stateProof,expected.stateProof); assert.equal(result.byteProfile.hasBom,true);
    assert.equal(archive.before.diagnostics.degraded,true); assert.deepEqual(archive.before.diagnostics.projectionError,active.projectionError);
  } finally { doc.destroy(); }
});

test('restore rejects replacement identity, wrong archive generation, changed bytes/clocks and derived/quarantine metadata', () => {
  const doc = createPlainTextYDoc('Original');
  try {
    const active = stateFor(doc,'plain_text'), expected = expectedFor(active), archive = prepareNativeFileArchiveTransition(active,expected,selection),
      state = archivedState(active,archive), restore = { trashEntryId: selection.trashEntryId,restoredAt: 400 };
    for (const change of [{ documentId: 'D2' },{ workspaceId: 'foreign' },{ organizationId: 'foreign' },{ path: 'other.md' },
      { representation: 'tiptap_xml' },{ schemaVersion: 2 },{ lifecycleGeneration: 4 },{ lifecycleGeneration: 6 },{ status: 'active' },
      { documentSequence: 8 },{ persistedAt: 101 },{ yjsState: new Uint8Array([0,0]) },{ stateVector: new Uint8Array([0]) },
      { newlineStyle: 'lf' },{ hasBom: false },{ checkpointSequence: 1 },{ checkpointedAt: 300 },{ canonicalHash: 'a'.repeat(64) },
      { serializedHash: 'b'.repeat(64) },{ projectionFinalized: true },{ degraded: true },
      { projectionError: { code: 'failure',sequence: 7,permanent: false } },
      { projectionError: { code: 'failure',sequence: 7,permanent: true } }]) {
      const candidate = { ...state,...change } as PersistedCollaborationState, before = structuredClone(candidate);
      assert.throws(() => prepareNativeFileRestoreTransition(candidate,expected,archive,restore));
      assert.deepEqual(candidate,before);
    }
    for (const change of [{ lineageId: 'L2' },{ registryStateVersion: 5 },{ binaryHash: '0'.repeat(64) },
      { vectorHash: '0'.repeat(64) },{ stateProof: `yjs-snapshot-sha256-v1:${'0'.repeat(64)}` }]) {
      assert.throws(() => prepareNativeFileRestoreTransition(state,{ ...expected,...change },archive,restore),/SOURCE_CHANGED/u);
    }
    for (const change of [{ hasBom: '0' },{ degraded: '0' },{ projectionFinalized: '0' }]) {
      assert.throws(() => prepareNativeFileRestoreTransition({ ...state,...change } as unknown as PersistedCollaborationState,expected,archive,restore),/INVALID/u);
    }
    assert.throws(() => prepareNativeFileRestoreTransition(state,expected,archive,{ ...restore,trashEntryId: 'another-trash' }),/SOURCE_CHANGED/u);
    assert.throws(() => prepareNativeFileRestoreTransition(state,expected,archive,{ ...restore,restoredAt: 299 }),/INVALID/u);
    assert.throws(() => prepareNativeFileRestoreTransition(state,{ ...expected,lifecycleGeneration: Number.MAX_SAFE_INTEGER-2 },archive,restore),/INVALID/u);
    assert.throws(() => prepareNativeFileRestoreTransition({ ...state,yjsState: new Uint8Array(16*1024*1024+1) },expected,archive,restore),/TOO_LARGE/u);
    assert.throws(() => prepareNativeFileRestoreTransition({ ...state,stateVector: new Uint8Array(1024*1024+1) },expected,archive,restore),/TOO_LARGE/u);
  } finally { doc.destroy(); }
});

test('restore validates the entire archive recipe and captures bounded DATA without accessors or mutable aliases', () => {
  const doc = createPlainTextYDoc('Original');
  try {
    const active = stateFor(doc,'plain_text'), expected = expectedFor(active), archive = prepareNativeFileArchiveTransition(active,expected,selection),
      state = archivedState(active,archive), restore = { trashEntryId: selection.trashEntryId,restoredAt: 400 };
    for (const mutate of [
      (copy: NativeFileArchiveTransition) => { (copy.after.identity as { documentId: string }).documentId = 'D2'; },
      (copy: NativeFileArchiveTransition) => { (copy.before.clock as { persistedAt: number }).persistedAt++; },
      (copy: NativeFileArchiveTransition) => { (copy.cas.lineage as { lineageId: string }).lineageId = 'L2'; },
      (copy: NativeFileArchiveTransition) => { (copy.writes.state as { lifecycleGeneration: number }).lifecycleGeneration++; },
      (copy: NativeFileArchiveTransition) => { (copy.writes.projection as { finalized: boolean }).finalized = true; },
      (copy: NativeFileArchiveTransition) => { (copy.before.diagnostics as { degraded: boolean }).degraded = true; },
      (copy: NativeFileArchiveTransition) => { Object.assign(copy,{ unrecognized: 'future' }); },
    ]) {
      const copy = structuredClone(archive); mutate(copy);
      assert.throws(() => prepareNativeFileRestoreTransition(state,expected,copy,restore),/INVALID|SOURCE_CHANGED/u);
    }
    let getters = 0; const accessor = { ...archive };
    Object.defineProperty(accessor,'before',{ enumerable: true,get() { getters++; return archive.before; } });
    assert.throws(() => prepareNativeFileRestoreTransition(state,expected,accessor,restore),/INVALID/u); assert.equal(getters,0);
    const copied = captureNativeFileArchiveRestoreData(structuredClone(archive)); assertFrozen(copied);
    assert.notEqual(copied,archive); assert.notEqual(copied.before,archive.before);
    assert.deepEqual(copied,archive);
    const cyclic: Record<string,unknown> = {}; cyclic.self = cyclic;
    assert.throws(() => captureNativeFileArchiveRestoreData(cyclic),/INVALID/u);
    assert.throws(() => captureNativeFileArchiveRestoreData({ huge: 'x'.repeat(8193) }),/INVALID/u);
    assert.throws(() => prepareNativeFileRestoreTransition(state,expected,archive,{ ...restore,extra: true } as typeof restore),
      error => error instanceof NativeFileRestoreTransitionError && error.code === 'NATIVE_FILE_RESTORE_INVALID');
  } finally { doc.destroy(); }
});

// Deliberately synthetic, structurally matching receipts isolate native decoder
// checks; these test values do not claim a real immutable SQL receipt/authority.
function recipeWithClock(archive: NativeFileArchiveTransition, expected: NativeFileArchiveExpected): NativeFileArchiveTransition {
  const clock = { documentSequence: expected.documentSequence,persistedAt: expected.persistedAt,stateProof: expected.stateProof,
    binaryHash: expected.binaryHash,vectorHash: expected.vectorHash };
  return { ...archive,before: { ...archive.before,clock },after: { ...archive.after,clock },
    cas: { ...archive.cas,state: { ...archive.cas.state,...clock } } };
}

test('restore deletion-sensitive proof rejects deletion with unchanged vector and freshly matching binary hash', () => {
  const doc = createPlainTextYDoc('Original body');
  try {
    const active = stateFor(doc,'plain_text'), expected = expectedFor(active), archive = prepareNativeFileArchiveTransition(active,expected,selection);
    doc.getText('content').delete(0,1);
    const yjsState = Y.encodeStateAsUpdate(doc), stateVector = Y.encodeStateVector(doc);
    assert.equal(digest(stateVector),expected.vectorHash);
    const changed = { ...expected,binaryHash: digest(yjsState) }, state = { ...archivedState(active,archive),yjsState,stateVector };
    assert.throws(() => prepareNativeFileRestoreTransition(state,changed,recipeWithClock(archive,changed),
      { trashEntryId: selection.trashEntryId,restoredAt: 400 }),/SOURCE_CHANGED/u);
  } finally { doc.destroy(); }
});

test('restore inspects actual archived schema and binary completeness after matching recipe hashes', () => {
  const doc = createRichMarkdownYDoc('Original','tiptap_xml');
  try {
    const active = stateFor(doc,'tiptap_xml'), expected = expectedFor(active), archive = prepareNativeFileArchiveTransition(active,expected,selection);
    (doc.getXmlFragment('body').toArray()[0] as InstanceType<typeof Y.XmlElement>).setAttribute('futureAttr','future-value');
    const unknownState = stateFor(doc,'tiptap_xml'), unknownExpected = expectedFor(unknownState);
    const unknown = { ...archivedState(active,archive),yjsState: unknownState.yjsState,stateVector: unknownState.stateVector };
    assert.throws(() => prepareNativeFileRestoreTransition(unknown,unknownExpected,recipeWithClock(archive,unknownExpected),
      { trashEntryId: selection.trashEntryId,restoredAt: 400 }),/unsupported schema|schema_invalid/u);
    const state = archivedState(active,archive);
    const suffix = Uint8Array.from([...state.yjsState,0]), badVector = new Uint8Array([0]);
    for (const [candidate,changed,pattern] of [
      [{ ...state,yjsState: suffix },{ ...expected,binaryHash: digest(suffix) },/trailing/u],
      [{ ...state,stateVector: badVector },{ ...expected,vectorHash: digest(badVector) },/vector/u],
    ] as const) {
      assert.throws(() => prepareNativeFileRestoreTransition(candidate,changed,recipeWithClock(archive,changed),
        { trashEntryId: selection.trashEntryId,restoredAt: 400 }),pattern);
    }
  } finally { doc.destroy(); }
});
