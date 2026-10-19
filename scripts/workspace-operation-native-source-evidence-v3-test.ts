import assert from 'node:assert/strict';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks, originalPhysicalSourceProof, workspaceSourceAuthorityStageProof,
  type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../app/lib/markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationNativeSourceEvidence, captureWorkspaceOperationNativeSourceEvidenceV2,
  WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { captureWorkspaceOperationNativeSourceEvidenceV3, decodeWorkspaceOperationNativeSourceEvidenceV3,
  assertWorkspaceOperationNativeSourceEvidenceV3Current } from '../app/lib/files/workspace-operation-native-source-evidence-v3';
import { nativeCopyMetadataFixture } from './helpers/native-copy-metadata-codec-fixture';
import { captureWorkspaceOperationNativePlanData } from '../app/lib/files/workspace-operation-native-plan-data';
import { assertWorkspaceOperationMixedSourceCurrent, decodeWorkspaceOperationMixedSourceEvidence,
  workspaceOperationMixedSourceSnapshot, workspaceOperationSourceNamespace, workspaceOperationSourceNativeEvidence,
  workspaceOperationSourceScope } from '../app/lib/files/workspace-operation-mixed-source-evidence';

// Actual Yjs/inventory/parser/old Evidence codecs; declared namespace/catalogue
// facts only. No DB, FS, principal, lifecycle, import, graph consumer or owner proof.
export function v3EvidenceFixture(representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text') {
  const original = nativeCopyMetadataFixture(representation), scope = original.plan.sourceEvidence.workspaceScope;
  const nativeBindings = original.plan.sourceEvidence.nativeBindings.map(binding => ({ ...structuredClone(binding),
    expected: { ...binding.expected, registryStateVersion: 6 }, registry: { ...binding.registry, stateVersion: 6 } }));
  const privateCatalogue: WorkspaceDocumentCatalogueEntry[] = nativeBindings.map(binding => ({ id: binding.expected.documentId,
    lineage_id: binding.expected.lineageId, path: binding.expected.path, workspace_id: scope.workspaceId,
    organization_id: scope.organizationId, status: 'active', state_version: 6, yjs_state_lifecycle: 'initialized',
    has_persisted_state: true, has_state_history: true, lifecycle_generation: binding.expected.lifecycleGeneration,
    authority: 'initialized', state_status: 'active', state_path: binding.expected.path,
    state_workspace_id: scope.workspaceId, state_organization_id: scope.organizationId }));
  privateCatalogue.push({ id: 'pristine-document', lineage_id: 'pristine-lineage', path: 'Pristine.md', workspace_id: scope.workspaceId,
    organization_id: scope.organizationId, status: 'active', state_version: 0, yjs_state_lifecycle: 'never_initialized',
    has_persisted_state: false, has_state_history: false, lifecycle_generation: null, authority: 'pristine',
    state_status: null, state_path: null, state_workspace_id: null, state_organization_id: null });
  const stage: WorkspaceSourceAuthorityStage = structuredClone(original.plan.sourceEvidence.stage);
  stage.namespace.push({ workspaceId: scope.workspaceId, path: 'raw', kind: 'directory', identity: '1:40:4096:100:100',
    filesystemIdentity: '1:40:4096:100:100', documentId: null, lifecycleGeneration: null });
  for (const [index, [filePath, source]] of [
    ['raw/Unrelated.md', '\uFEFF---\r\naliases: [Shared, "😀 Alias"]\r\n---\r\n\r\n# 😀 Heading\r\n\r\n[Keep](../keep.md#Part) [[Pristine|Shown]]'],
    ['Pristine.md', '---\naliases: [Original]\n---\n\n# Original\n\n[Keep](keep.md)'],
  ].entries()) {
    const bytes = Buffer.from(source), identity = `1:${41 + index}:${bytes.length}:100:100`;
    stage.namespace.push({ workspaceId: scope.workspaceId, path: filePath, kind: 'file', identity,
      filesystemIdentity: identity, documentId: null, lifecycleGeneration: null });
    stage.sources.push({ kind: 'physical', inventory: inspectOriginalPhysicalLinks({ workspaceId: scope.workspaceId,
      organizationId: scope.organizationId, path: filePath, bytes, filesystemIdentity: identity,
      authority: { kind: 'unregistered', catalogueProof: '0'.repeat(64) } }) });
  }
  const observation = { stage, nativeBindings,
    privateNativeStates: structuredClone(original.nativeRecords.filter(record => record.state.workspaceId === scope.workspaceId).map(record => record.state)),
    privateCatalogue };
  refreshV3EvidenceFixture(observation);
  return { scope, observation };
}
function refreshV3EvidenceFixture(observation: WorkspaceLinkSourceAuthorityObservation & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] }): void {
  observation.stage.catalogueProof = proof(observation.privateCatalogue);
  observation.stage.sources = observation.stage.sources.map(source => {
    if (source.kind !== 'physical') return source;
    const entry = observation.privateCatalogue.find(row => row.path === source.inventory.path);
    return { kind: 'physical', inventory: inspectOriginalPhysicalLinks({ workspaceId: source.inventory.workspaceId,
      organizationId: source.inventory.organizationId, path: source.inventory.path, bytes: source.inventory.originalBytes,
      filesystemIdentity: source.inventory.physical.filesystemIdentity, authority: entry ? {
        kind: 'registered-never-initialized', catalogueProof: observation.stage.catalogueProof!,
        registeredDocumentId: entry.id, lineageId: entry.lineage_id,
      } : { kind: 'unregistered', catalogueProof: observation.stage.catalogueProof! } }) };
  });
  observation.stage.readiness = observation.stage.sources.some(source => source.kind === 'physical')
    ? 'requires-import-and-rebinding' : 'native-coordinator-required';
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}
function assertV3EvidenceRejected(operation: () => unknown,
  code: WorkspaceOperationNativeSourceEvidenceError['code'] = 'NATIVE_SOURCE_EVIDENCE_INVALID'): void {
  assert.throws(operation, error => error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === code && error.status === 409);
}

export function workspaceOperationNativeSourceEvidenceV3Test(): void {
  let passed = 0;
  // 1. Full graph facts, actual parser/three native representations, no bytes in history.
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const fixture = v3EvidenceFixture(representation), before = structuredClone(fixture);
    const evidence = captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation);
    assert.equal(evidence.evidenceVersion, 3); assert.equal(evidence.nativeComponent.evidenceVersion, 2);
    assert.deepEqual(evidence.namespace, fixture.observation.stage.namespace);
    assert.equal(evidence.physicalSources.length, 2); assert.equal(evidence.nativeComponent.nativeBindings.length, 2);
    const raw = evidence.physicalSources.find(source => source.path === 'raw/Unrelated.md')!;
    assert.deepEqual(raw.metadata.aliases, ['Shared', '😀 Alias']); assert.equal(raw.links.length, 2);
    assert.equal(raw.hasBom, true); assert.equal(raw.lineEndings.style, 'crlf');
    assert.equal(raw.authority.kind, 'unregistered');
    assert.equal(evidence.physicalSources.find(source => source.path === 'Pristine.md')!.authority.kind, 'registered-never-initialized');
    assert(evidence.nativeComponent.stage.scope.excludedPaths.includes(raw.path));
    assert(!evidence.nativeComponent.stage.namespace.some(entry => entry.path === raw.path));
    assert.equal(evidence.namespace.find(entry => entry.path === raw.path)!.documentId, null);
    assert(Object.isFrozen(evidence) && Object.isFrozen(raw.metadata.aliases) && Object.isFrozen(raw.links[0].targetRange));
    const json = JSON.stringify(evidence);
    for (const key of ['originalBytes', 'privateCatalogue', 'privateNativeStates', 'yjsState']) assert.equal(json.includes(`"${key}"`), false);
    assert.deepEqual(decodeWorkspaceOperationNativeSourceEvidenceV3(JSON.parse(json)), evidence);
    assert.deepEqual(decodeWorkspaceOperationMixedSourceEvidence(JSON.parse(json)), evidence);
    assert.equal(workspaceOperationSourceNativeEvidence(evidence), evidence.nativeComponent);
    assert.deepEqual(workspaceOperationSourceNamespace(evidence), fixture.observation.stage.namespace);
    assert.deepEqual(workspaceOperationSourceScope(evidence), fixture.observation.stage.scope);
    const graphSnapshot = workspaceOperationMixedSourceSnapshot(evidence);
    assert.equal(graphSnapshot.contractVersion, 3); assert.deepEqual(graphSnapshot.namespace, evidence.namespace);
    assert.deepEqual(graphSnapshot.physicalSources, evidence.physicalSources);
    assert.equal(workspaceOperationMixedSourceSnapshot(evidence.nativeComponent).contractVersion, 2);
    assertWorkspaceOperationNativeSourceEvidenceV3Current(evidence, fixture.observation, fixture.scope);
    assertWorkspaceOperationMixedSourceCurrent(evidence, fixture.observation, fixture.scope);
    assert.deepEqual(fixture, before);
    fixture.observation.stage.namespace[0].filesystemIdentity = '9:99:0:1:1';
    assert.notDeepEqual(evidence.namespace, fixture.observation.stage.namespace);
  }
  passed++;

  // 2. Old native-only codecs retain their strict rejection and bytes.
  {
    const fixture = v3EvidenceFixture(), native = structuredClone(fixture.observation);
    native.stage.sources = native.stage.sources.filter(source => source.kind === 'native');
    native.stage.namespace = native.stage.namespace.filter(entry => !/\/(?:Unrelated)\.md$|^Pristine\.md$/u.test(entry.path));
    native.privateCatalogue = native.privateCatalogue.filter(row => row.authority === 'initialized');
    refreshV3EvidenceFixture(native);
    const v1 = captureWorkspaceOperationNativeSourceEvidence(fixture.scope, native);
    const v2 = captureWorkspaceOperationNativeSourceEvidenceV2(fixture.scope, native);
    const before = [JSON.stringify(v1), JSON.stringify(v2)];
    captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation);
    assert.deepEqual([JSON.stringify(captureWorkspaceOperationNativeSourceEvidence(fixture.scope, native)),
      JSON.stringify(captureWorkspaceOperationNativeSourceEvidenceV2(fixture.scope, native))], before);
    assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV2(fixture.scope, fixture.observation), 'NATIVE_SOURCE_IMPORT_REQUIRED');
    assertV3EvidenceRejected(() => decodeWorkspaceOperationNativeSourceEvidenceV3(v1));
    assertV3EvidenceRejected(() => decodeWorkspaceOperationNativeSourceEvidenceV3(v2));
  }
  passed++;

  // 3. Rehashed forged aliases/links cannot replace actual physical parser output.
  for (const field of ['aliases', 'links', 'source-bytes'] as const) {
    const fixture = v3EvidenceFixture();
    const source = fixture.observation.stage.sources.find(source => source.kind === 'physical')!;
    assert(source.kind === 'physical');
    if (field === 'aliases') source.inventory.metadata.aliases.push('forged alias');
    else if (field === 'links') source.inventory.links.pop();
    else source.inventory.originalBytes[0] ^= 1;
    source.inventory.physicalSourceProof = originalPhysicalSourceProof(source.inventory);
    fixture.observation.stage.stageProof = workspaceSourceAuthorityStageProof(fixture.observation.stage);
    assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation));
  }
  passed++;

  // 4. Only a genuine complete semantic Catalogue witness allows checkpoint drift.
  {
    const fixture = v3EvidenceFixture(), original = captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation);
    const next = structuredClone(fixture);
    for (const binding of next.observation.nativeBindings) {
      binding.expected.registryStateVersion = 7; binding.registry.stateVersion = 7;
      next.observation.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = 7;
    }
    for (const entry of next.observation.stage.namespace) {
      if (entry.documentId !== null) entry.filesystemIdentity = '8:80:100:300:301';
      if (entry.path === 'raw') entry.identity = entry.filesystemIdentity = '1:40:8192:300:301';
    }
    refreshV3EvidenceFixture(next.observation);
    const current = captureWorkspaceOperationNativeSourceEvidenceV3(next.scope, next.observation);
    assert.notEqual(current.evidenceProof, original.evidenceProof);
    assert.notEqual(current.physicalSources[0].physicalSourceProof, original.physicalSources[0].physicalSourceProof);
    assert.notEqual(current.physicalSources[0].links[0].physicalLinkId, original.physicalSources[0].links[0].physicalLinkId);
    assert.equal(current.semanticProof, original.semanticProof);
    assertWorkspaceOperationNativeSourceEvidenceV3Current(original, next.observation, next.scope);
    const missing = { stage: next.observation.stage, nativeBindings: next.observation.nativeBindings, privateNativeStates: next.observation.privateNativeStates };
    assertV3EvidenceRejected(() => assertWorkspaceOperationNativeSourceEvidenceV3Current(original, missing, fixture.scope));
    assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope,
      { ...next.observation, privateCatalogue: next.observation.privateCatalogue.filter(row => row.path !== 'Pristine.md') }));
    const changed = structuredClone(next); changed.observation.privateCatalogue.find(row => row.path === 'Pristine.md')!.lineage_id = 'new-pristine-lineage';
    refreshV3EvidenceFixture(changed.observation);
    assertV3EvidenceRejected(() => assertWorkspaceOperationNativeSourceEvidenceV3Current(original, changed.observation, changed.scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  passed++;

  // 5. Every physical file pin and content change remains a Current conflict.
  for (const change of ['inode', 'mtime', 'content', 'scope'] as const) {
    const fixture = v3EvidenceFixture(), original = captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation);
    if (change === 'scope') {
      assertV3EvidenceRejected(() => assertWorkspaceOperationNativeSourceEvidenceV3Current(original, fixture.observation,
        { ...fixture.scope, rootPath: '/different/owned/root' }), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
      continue;
    }
    const source = fixture.observation.stage.sources.find(source => source.kind === 'physical')!; assert(source.kind === 'physical');
    const entry = fixture.observation.stage.namespace.find(entry => entry.path === source.inventory.path)!;
    if (change === 'content') source.inventory.originalBytes[Buffer.from(source.inventory.originalBytes).indexOf('Shared') + 1] = 120;
    else {
      const parts = source.inventory.physical.filesystemIdentity.split(':'); parts[change === 'inode' ? 1 : 3] = '900';
      entry.identity = entry.filesystemIdentity = source.inventory.physical.filesystemIdentity = parts.join(':');
    }
    refreshV3EvidenceFixture(fixture.observation);
    assertV3EvidenceRejected(() => assertWorkspaceOperationNativeSourceEvidenceV3Current(original, fixture.observation, fixture.scope), 'NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  passed++;

  // 6. Full membership, ancestry, scope and Catalogue-to-native partition remain strict.
  for (const boundary of ['missing-source', 'missing-parent', 'native-id', 'coverage', 'hidden-source', 'extra-initialized'] as const) {
    const fixture = v3EvidenceFixture();
    if (boundary === 'missing-source') fixture.observation.stage.sources = fixture.observation.stage.sources.filter(source => source.kind !== 'physical' || source.inventory.path !== 'raw/Unrelated.md');
    if (boundary === 'missing-parent') fixture.observation.stage.namespace = fixture.observation.stage.namespace.filter(entry => entry.path !== 'raw');
    if (boundary === 'native-id') fixture.observation.stage.namespace.find(entry => entry.path === 'Pristine.md')!.documentId = 'fabricated-native-id';
    if (boundary === 'coverage') fixture.observation.stage.coverage = { complete: false, gaps: [{ code: 'unreadable-source', path: 'raw/Unrelated.md' }] };
    if (boundary === 'hidden-source') fixture.observation.stage.scope.excludedPaths.push('raw/Unrelated.md');
    if (boundary === 'extra-initialized') {
      const row = structuredClone(fixture.observation.privateCatalogue[0]);
      row.id = 'unbound-native'; row.lineage_id = 'unbound-lineage'; row.path = row.state_path = 'unbound.md';
      fixture.observation.privateCatalogue.push(row);
    }
    refreshV3EvidenceFixture(fixture.observation);
    assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation));
  }
  passed++;

  // 7. Hostile descriptors/proxies reject without user getters or proxy traps.
  for (const boundary of ['root', 'revoked', 'bytes-getter', 'metadata-getter', 'array-hole'] as const) {
    const fixture = v3EvidenceFixture(); let traps = 0;
    let supplied: unknown = fixture.observation;
    const source = fixture.observation.stage.sources.find(source => source.kind === 'physical')!; assert(source.kind === 'physical');
    if (boundary === 'root') supplied = new Proxy(fixture.observation, { getPrototypeOf() { traps++; throw new Error('trap'); } });
    if (boundary === 'revoked') { const proxy = Proxy.revocable(fixture.observation, {}); supplied = proxy.proxy; proxy.revoke(); }
    if (boundary === 'bytes-getter') Object.defineProperty(source.inventory, 'originalBytes', { enumerable: true, get() { traps++; return Buffer.alloc(0); } });
    if (boundary === 'metadata-getter') Object.defineProperty(source.inventory.metadata, 'aliases', { enumerable: true, get() { traps++; return []; } });
    if (boundary === 'array-hole') delete (fixture.observation.stage.sources as unknown as Record<number, unknown>)[0];
    assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, supplied as WorkspaceLinkSourceAuthorityObservation));
    assert.equal(traps, 0, boundary);
  }
  passed++;

  // 8. Historical exact keys/Unicode/escaped bytes stay bounded without private bytes.
  {
    const fixture = v3EvidenceFixture(), evidence = captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation);
    for (const malformed of [null, { ...evidence, privateCatalogue: [] }, { ...evidence, physicalSources: [{ ...evidence.physicalSources[0], originalBytes: [] }] }]) {
      assertV3EvidenceRejected(() => decodeWorkspaceOperationNativeSourceEvidenceV3(malformed));
    }
    const unicode = structuredClone(evidence);
    unicode.physicalSources[0].metadata.aliases.push('\ud800');
    assertV3EvidenceRejected(() => decodeWorkspaceOperationNativeSourceEvidenceV3(unicode));
    assertV3EvidenceRejected(() => decodeWorkspaceOperationNativeSourceEvidenceV3({ padding: '"'.repeat(4 * 1024 * 1024 + 1) }), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    const raw = fixture.observation.stage.sources.find(source => source.kind === 'physical')!; assert(raw.kind === 'physical');
    const historical = evidence.physicalSources.find(source => source.path === raw.inventory.path)!;
    assert.equal(Object.hasOwn(historical, 'originalBytes'), false);
    assert.equal(historical.physical.byteHash, raw.inventory.physical.byteHash);
  }
  passed++;
  // 9. No untrusted callback may run before the safe descriptor capture.
  for (const boundary of ['native-getter', 'native-nested-getter', 'native-toJSON-getter', 'native-toJSON-function',
    'native-proxy', 'native-revoked-proxy', 'physical-inherited-toJSON'] as const) {
    const fixture = v3EvidenceFixture(), baseline = captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation);
    const source = fixture.observation.stage.sources.find(source => source.kind === 'native')!; assert(source.kind === 'native');
    let callbacks = 0;
    if (boundary === 'native-getter') {
      const metadata = source.inventory.metadata;
      Object.defineProperty(source.inventory, 'metadata', { enumerable: true, get() { callbacks++; return metadata; } });
    } else if (boundary === 'native-nested-getter') {
      const aliases = source.inventory.metadata.aliases;
      Object.defineProperty(source.inventory.metadata, 'aliases', { enumerable: true, get() { callbacks++; return aliases; } });
    } else if (boundary === 'native-toJSON-getter') {
      Object.defineProperty(source.inventory, 'toJSON', { get() { callbacks++; return undefined; } });
    } else if (boundary === 'native-toJSON-function') {
      const original = structuredClone(source.inventory);
      Object.defineProperty(source.inventory, 'toJSON', { value() { callbacks++; return original; } });
    } else if (boundary === 'native-proxy') {
      source.inventory = new Proxy(source.inventory, { get(target, key) { callbacks++; return Reflect.get(target, key); },
        ownKeys(target) { callbacks++; return Reflect.ownKeys(target); } });
    } else if (boundary === 'native-revoked-proxy') {
      const pair = Proxy.revocable(source.inventory, {}); pair.revoke(); source.inventory = pair.proxy;
    } else {
      const raw = fixture.observation.stage.sources.find(source => source.kind === 'physical')!; assert(raw.kind === 'physical');
      const aliases = raw.inventory.metadata.aliases, safeValues = [...aliases], prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, 'toJSON', { value() { callbacks++; return safeValues; } });
      Object.setPrototypeOf(aliases, prototype);
    }
    if (boundary === 'physical-inherited-toJSON') {
      assert.deepEqual(captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation), baseline);
    } else assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation));
    assert.equal(callbacks, 0, boundary);
  }
  passed++;
  // 10. Combined bounds reject before actual binary copying or source decoding.
  for (const boundary of ['combined-bytes', 'combined-links'] as const) {
    const fixture = v3EvidenceFixture();
    if (boundary === 'combined-bytes') {
      for (const state of fixture.observation.privateNativeStates) state.yjsState = new Uint8Array(16 * 1024 * 1024);
    } else {
      const sources = fixture.observation.stage.sources.filter(source => source.kind === 'native');
      const link = sources.flatMap(source => source.inventory.links)[0]; assert(link);
      for (const source of sources) source.inventory.links = Array.from({ length: 10_001 }, () => link);
    }
    const setOwner = Object.getPrototypeOf(Uint8Array.prototype);
    const setDescriptor = Object.getOwnPropertyDescriptor(setOwner, 'set');
    const decodeDescriptor = Object.getOwnPropertyDescriptor(TextDecoder.prototype, 'decode');
    assert(setDescriptor && decodeDescriptor);
    let copies = 0, decodes = 0;
    try {
      Object.defineProperty(setOwner, 'set', { ...setDescriptor,
        value(this: Uint8Array, ...args: Parameters<Uint8Array['set']>) { copies++; return Reflect.apply(setDescriptor.value, this, args); } });
      Object.defineProperty(TextDecoder.prototype, 'decode', { ...decodeDescriptor,
        value(this: TextDecoder, ...args: Parameters<TextDecoder['decode']>) { decodes++; return Reflect.apply(decodeDescriptor.value, this, args); } });
      assertV3EvidenceRejected(() => captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    } finally {
      Object.defineProperty(setOwner, 'set', setDescriptor); Object.defineProperty(TextDecoder.prototype, 'decode', decodeDescriptor);
    }
    assert.equal(copies, 0, boundary); assert.equal(decodes, 0, boundary);
  }
  passed++;
  // 11. Escaped JSON is bounded before serialization; exact byte boundaries
  // include keys, punctuation, surrogate escapes, Unicode and numeric forms.
  {
    const padding = '\u0000'.repeat(Math.floor(8 * 1024 * 1024 / 6) + 1);
    const descriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify')!; let serializations = 0;
    try {
      Object.defineProperty(JSON, 'stringify', { ...descriptor,
        value(...args: Parameters<JSON['stringify']>) { serializations++; return Reflect.apply(descriptor.value, JSON, args); } });
      assertV3EvidenceRejected(() => decodeWorkspaceOperationNativeSourceEvidenceV3({ padding }), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    } finally { Object.defineProperty(JSON, 'stringify', descriptor); }
    assert.equal(serializations, 0);
    const reject = (reason: 'invalid' | 'too-large'): never => { throw new Error(reason); };
    for (const value of [null, true, false, 0, -0, 1.25, 1e-7, [], {}, { 'q"': '\u0000\t\ud800😀\\' }, ['a\n', 'e\u2028']]) {
      const length = Buffer.byteLength(JSON.stringify(value));
      assert.deepEqual(captureWorkspaceOperationNativePlanData(value, reject, length), value);
      assert.deepEqual(captureWorkspaceOperationNativePlanData(value, reject), value);
      if (length > 1) assert.throws(() => captureWorkspaceOperationNativePlanData(value, reject, length - 1), /too-large/u);
    }
  }
  passed++;
  assert.equal(passed, 11);
  console.log(JSON.stringify({ suite: 'native-source-evidence-v3', passed, pureFactsOnly: true }));
}
