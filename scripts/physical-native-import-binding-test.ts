import assert from 'node:assert/strict';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { prepareMarkdownFileImport } from '../app/lib/collaboration/markdown-file-import';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { bindPhysicalNativeImportLinks, PhysicalNativeImportBindingError,
  type PhysicalNativeImportBindingInput } from '../app/lib/markdown/physical-native-import-binding';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';
import { inspectPersistedDocumentLinks, inspectPersistedDocumentLinksV3,
  nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks } from '../app/lib/markdown/workspace-physical-link-inventory';

// Actual parser/import/native/forward+inverse helpers, with explicitly declared
// receipt/lineage facts. This pure suite proves neither SQL receipts nor rights,
// actual inode ownership, CopyOwner integration, recovery or filesystem work.
function fixture(source: string, representation: PersistedCollaborationState['representation'] = 'plain_text',
  targetPath = 'source/original.md', targetWorkspaceId = 'source-workspace', registered = false): PhysicalNativeImportBindingInput {
  const bytes = Buffer.from(source, 'utf8'), prepared = prepareMarkdownFileImport(bytes, { representation });
  const sameTarget = targetPath === 'source/original.md' && targetWorkspaceId === 'source-workspace';
  const state: PersistedCollaborationState = { documentId: registered && sameTarget ? 'registered-pristine-document' : 'actual-import-document',
    workspaceId: targetWorkspaceId, organizationId: null, path: targetPath, representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: prepared.yjsState, stateVector: prepared.stateVector, documentSequence: 0, persistedAt: 1234,
    checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: prepared.newlineStyle, hasBom: prepared.hasBom, degraded: false, status: 'active', projectionFinalized: false };
  const native = authoritativeNativeCollaborationSnapshot(state);
  const lineageId = registered && sameTarget ? 'pristine-original-lineage' : 'actual-import-lineage';
  const receipt: MarkdownFileImportReceipt = { version: 1, operationId: 'pure-import-operation', requestFingerprint: 'b'.repeat(64),
    sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes, checkpointRequired: true,
    target: { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
      representation: state.representation, lifecycleGeneration: 1, schemaVersion: 1, newlineStyle: state.newlineStyle, hasBom: state.hasBom,
      lineageId, initialSequence: 0, initialStateProof: native.version.stateProof, persistedAt: state.persistedAt } };
  const original = inspectOriginalPhysicalLinks({ workspaceId: 'source-workspace', organizationId: null, path: 'source/original.md',
    authority: registered ? { kind: 'registered-never-initialized', catalogueProof: 'a'.repeat(64),
      registeredDocumentId: 'registered-pristine-document', lineageId: 'pristine-original-lineage' }
      : { kind: 'unregistered', catalogueProof: 'a'.repeat(64) }, bytes,
    filesystemIdentity: `1:42:${bytes.byteLength}:100:101` });
  assert.equal(original.coverage.complete, true);
  return { original, receipt, state, lineageId };
}
function expectReject(input: PhysicalNativeImportBindingInput, code?: PhysicalNativeImportBindingError['code']): void {
  assert.throws(() => bindPhysicalNativeImportLinks(input), error => error instanceof PhysicalNativeImportBindingError
    && (code === undefined || error.code === code));
}

export function physicalNativeImportBindingTest(): void {
  let passed = 0;
  // Probes are unique per occurrence, so identical duplicate targets cannot be
  // silently swapped. All native references come from this actual state.
  {
    const input = fixture('\uFEFF---\r\ntitle: Exact import\r\naliases: [Alias]\r\ntags: [tag]\r\n---\r\n\r\n# Note\r\n\r\n😀 [one](target.md) [two](target.md)\r\n\r\n[[target.md#Heading|Label]]\r\n\r\n![[image.png|Picture]]\r\n');
    const before = structuredClone(input), legacy = inspectPersistedDocumentLinks(input.state);
    assert.equal(legacy.parserVersion, 2);
    assert.deepEqual(legacy.metadata.headings, [{ depth: 2, text: 'tags: [tag]' }, { depth: 1, text: 'Note' }]);
    const binding = bindPhysicalNativeImportLinks(input);
    assert.equal(binding.nativeInventory.parserVersion, 3);
    assert.deepEqual(binding.nativeInventory.metadata, input.original.metadata);
    assert.deepEqual(binding.nativeInventory, inspectPersistedDocumentLinksV3(input.state));
    assert.deepEqual(inspectPersistedDocumentLinks(input.state), legacy, 'historical V2 output is retained');
    assert.equal(binding.version, 1); assert.equal(binding.source.physicalSourceProof, input.original.physicalSourceProof);
    assert.equal(binding.source.filesystemIdentity, input.original.physical.filesystemIdentity);
    assert.deepEqual(binding.receipt, input.receipt); assert.equal(binding.links.length, 4);
    assert.equal(new Set(binding.links.map(link => link.physicalLinkId)).size, 4);
    assert.equal(new Set(binding.links.map(link => link.nativeLinkId)).size, 4);
    assert.equal(new Set(binding.links.map(link => link.occurrenceProof)).size, 4);
    const inventory = inspectPersistedDocumentLinks(input.state);
    for (const link of binding.links) {
      assert.deepEqual(link.reference, inventory.links.find(candidate => candidate.id === link.nativeLinkId)!.ref);
      assert.equal(link.reference.kind, 'plain-target');
      if (link.reference.kind === 'plain-target') {
        assert(link.reference.text.startAnchor); assert(link.reference.text.endAnchor);
      }
    }
    const { bindingProof, ...body } = binding;
    assert.equal(bindingProof, nativeLinkJsonProof(body));
    assert.deepEqual(bindPhysicalNativeImportLinks(input), binding, 'scratch Yjs client clocks never enter the binding proof');
    assert(Object.isFrozen(binding)); assert(Object.isFrozen(binding.links)); assert(Object.isFrozen(binding.nativeInventory));
    assert.deepEqual(input, before, 'the real original bytes and native binary/vector are never changed');
  }
  passed++;

  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const source = '# Heading\n\n[one](target.md)\n\n[two](target.md)\n\n[[target.md#Heading|Label]]\n\n![[image.png|Picture]]\n';
    const input = fixture(source, representation), before = structuredClone(input);
    const binding = bindPhysicalNativeImportLinks(input);
    assert.equal(binding.nativeInventory.document.representation, representation);
    assert.equal(binding.links.length, 4); assert.equal(new Set(binding.links.map(link => link.nativeLinkId)).size, 4);
    assert(binding.links.every(link => link.reference.kind !== 'plain-target'));
    assert.deepEqual(bindPhysicalNativeImportLinks(input), binding);
    assert.deepEqual(input, before);
  }
  passed++;

  // Path-derived metadata changes at the target are factual and expected; no
  // source native identity is fabricated for a cross-workspace import.
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const input = fixture('[one](../target.md)\n', representation, 'destination/renamed.md', 'different-workspace');
    const binding = bindPhysicalNativeImportLinks(input);
    assert.equal(binding.source.workspaceId, 'source-workspace'); assert.equal(binding.source.path, 'source/original.md');
    assert.equal(binding.nativeInventory.document.workspaceId, 'different-workspace');
    assert.equal(binding.nativeInventory.document.path, 'destination/renamed.md');
    assert.equal(binding.nativeInventory.metadata.title, 'renamed'); assert.equal(binding.nativeInventory.metadata.path, 'destination/renamed.md');
    assert.equal(binding.nativeInventory.document.documentId, input.receipt.target.documentId);
    assert.equal(binding.links.length, 1);
  }
  passed++;

  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) for (const source of ['', '\uFEFF', '# Heading\n']) {
    const input = fixture(source, representation);
    const binding = bindPhysicalNativeImportLinks(input);
    assert.deepEqual(binding.links, []); assert.equal(binding.source.sourceBytes, Buffer.byteLength(source));
  }
  passed++;

  {
    const input = fixture('[one](target.md)\n', 'plain_text', 'source/original.md', 'source-workspace', true);
    assert.equal(bindPhysicalNativeImportLinks(input).nativeInventory.document.documentId, 'registered-pristine-document');
    const wrongIdentity = structuredClone(input); wrongIdentity.state.documentId = 'different-pristine-winner';
    wrongIdentity.receipt.target.documentId = wrongIdentity.state.documentId;
    expectReject(wrongIdentity, 'CHANGED');
    const wrongLineage = structuredClone(input);
    Reflect.set(wrongLineage, 'lineageId', 'replacement-lineage'); wrongLineage.receipt.target.lineageId = 'replacement-lineage';
    expectReject(wrongLineage, 'CHANGED');
    const copy = fixture('[one](target.md)\n', 'plain_text', 'destination/copy.md', 'different-workspace', true);
    const copied = bindPhysicalNativeImportLinks(copy);
    assert.notEqual(copied.nativeInventory.document.documentId, 'registered-pristine-document');
    assert.notEqual(copied.receipt.target.lineageId, 'pristine-original-lineage');
  }
  passed++;

  for (const change of ['receipt-version', 'state-proof', 'state-vector', 'sequence', 'generation', 'source-hash', 'source-bytes',
    'target-path', 'target-workspace', 'target-organization', 'lineage', 'profile', 'persisted-at', 'extra-receipt', 'bytes', 'fd-proof',
    'parser-span', 'duplicate-physical-id'] as const) {
    const input = fixture('[one](target.md) [two](target.md)\n');
    if (change === 'receipt-version') Reflect.set(input.receipt, 'version', 2);
    if (change === 'state-proof') input.receipt.target.initialStateProof = `yjs-snapshot-sha256-v1:${'f'.repeat(64)}`;
    if (change === 'state-vector') input.state.stateVector = Uint8Array.of(0);
    if (change === 'sequence') input.state.documentSequence = 1;
    if (change === 'generation') input.state.lifecycleGeneration = 2;
    if (change === 'source-hash') input.receipt.sourceHash = 'f'.repeat(64);
    if (change === 'source-bytes') input.receipt.sourceBytes++;
    if (change === 'target-path') input.receipt.target.path = 'replacement.md';
    if (change === 'target-workspace') input.receipt.target.workspaceId = 'replacement-workspace';
    if (change === 'target-organization') input.receipt.target.organizationId = 'replacement-organization';
    if (change === 'lineage') Reflect.set(input, 'lineageId', 'replacement-lineage');
    if (change === 'profile') input.state.hasBom = true;
    if (change === 'persisted-at') input.state.persistedAt++;
    if (change === 'extra-receipt') Reflect.set(input.receipt, 'actorGrant', true);
    if (change === 'bytes') input.original.originalBytes[0] ^= 1;
    if (change === 'fd-proof') input.original.physical.filesystemIdentity = '1:99:1:200:201';
    if (change === 'parser-span') input.original.links[0].targetRange.startUtf16++;
    if (change === 'duplicate-physical-id') input.original.links[1].physicalLinkId = input.original.links[0].physicalLinkId;
    const before = structuredClone(input); expectReject(input); assert.deepEqual(input, before);
  }
  passed++;

  // Matching target/receipt clocks cannot replace full original bytes or the
  // real persisted initial content proof, even if all links still look equal.
  {
    const input = fixture('# Original\n\n[one](target.md)\n');
    const replacement = fixture('# Replaced\n\n[one](target.md)\n');
    input.state.yjsState = replacement.state.yjsState; input.state.stateVector = replacement.state.stateVector;
    input.receipt.target.initialStateProof = replacement.receipt.target.initialStateProof;
    expectReject(input, 'CHANGED');
  }
  passed++;

  {
    const input = fixture('[one](target.md)\n');
    input.original.originalBytes = new Uint8Array(MAX_INDEXED_MARKDOWN_BYTES + 1);
    expectReject(input, 'UNSUPPORTED');
    const many = fixture(Array.from({ length: 1001 }, (_, index) => `[${index}](target.md)`).join(' '));
    expectReject(many, 'UNSUPPORTED');
  }
  passed++;

  // Every hostile value is rejected before a getter, Proxy trap, toJSON or
  // typed-array shadow accessor can execute.
  {
    let calls = 0;
    for (const key of ['original', 'receipt', 'state', 'lineageId'] as const) {
      const input = fixture('[one](target.md)\n');
      Object.defineProperty(input, key, { enumerable: true, get() { calls++; throw new Error('must not execute'); } });
      expectReject(input);
    }
    for (const key of ['original', 'receipt', 'state'] as const) {
      const input = fixture('[one](target.md)\n');
      Reflect.set(input, key, new Proxy(input[key], { ownKeys() { calls++; throw new Error('must not execute'); },
        getPrototypeOf() { calls++; throw new Error('must not execute'); } }));
      expectReject(input);
    }
    const nested = fixture('[one](target.md)\n');
    Object.defineProperty(nested.receipt.target, 'documentId', { enumerable: true, get() { calls++; return 'must-not-run'; } });
    expectReject(nested);
    const toJson = fixture('[one](target.md)\n');
    Reflect.set(toJson.original.metadata, 'toJSON', () => { calls++; throw new Error('must not execute'); });
    expectReject(toJson);
    const binaryShadow = fixture('[one](target.md)\n');
    Object.defineProperty(binaryShadow.state.yjsState, 'byteLength', { get() { calls++; return 1; } });
    expectReject(binaryShadow);
    assert.equal(calls, 0);
  }
  passed++;
  assert.equal(passed, 9);
  console.log(JSON.stringify({ suite: 'physical-native-import-binding', passed, pureFactsOnly: true,
    realParserAndNativeRehearsal: true, databaseOrAuthorityAcceptance: false }));
}

physicalNativeImportBindingTest();
