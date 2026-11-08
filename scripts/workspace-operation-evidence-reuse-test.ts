import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { getNativeInspectionSchema, withNativeInspectionSchema } from '../app/lib/collaboration/native-inspection-schema';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  assertWorkspaceOperationMixedSourceEvidenceV5Current, withMixedSourceEvidenceValidationReuse,
  type WorkspaceOperationMixedSourceEvidenceV5 } from '../app/lib/files/workspace-operation-mixed-source-evidence-v5';
import { WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

function hashes<T>(operation: () => T): { value: T; calls: number } {
  const original = crypto.createHash; let calls = 0;
  try {
    crypto.createHash = (...args: Parameters<typeof crypto.createHash>) => { calls++; return Reflect.apply(original, crypto, args); };
    syncBuiltinESMExports();
    return { value: operation(), calls };
  } finally { crypto.createHash = original; syncBuiltinESMExports(); }
}
function failure(operation: () => unknown): string {
  let error: unknown; try { operation(); } catch (caught) { error = caught; }
  assert(error instanceof WorkspaceOperationNativeSourceEvidenceError); return error.code;
}
function fixture(representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks') {
  const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['note.md', '[**Target**](target.md)'], ['target.md', '# Target']], raw: [] });
  if (representation !== 'plain_text') {
    const state = actual.observation.privateNativeStates.find(row => row.path === 'note.md')!;
    const doc = createRichMarkdownYDoc('[**Target**](target.md)', representation);
    try { state.representation = representation; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc); }
    finally { doc.destroy(); }
    const inventory = inspectPersistedDocumentLinks(state), binding = actual.observation.nativeBindings.find(row => row.expected.documentId === state.documentId)!;
    binding.expected.representation = representation; binding.expected.binaryHash = crypto.createHash('sha256').update(state.yjsState).digest('hex');
    binding.expected.vectorHash = crypto.createHash('sha256').update(state.stateVector).digest('hex');
    binding.expected.stateProof = inventory.version.stateProof; binding.inventoryProof = nativeLinkJsonProof(inventory);
    actual.observation.stage.sources = actual.observation.stage.sources.map(source => source.kind === 'native' && source.inventory.document.documentId === state.documentId
      ? { kind: 'native', inventory } : source);
    actual.observation.stage.stageProof = workspaceSourceAuthorityStageProof(actual.observation.stage);
  }
  return { ...actual, evidence: captureWorkspaceOperationMixedSourceEvidenceV5(actual.scope, actual.observation) };
}

/** Genuine Yjs and codecs, transparent hash counting; no SQL/FS/current authority claim. */
export async function workspaceOperationEvidenceReuseTest(): Promise<void> {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) await withNativeInspectionSchema(async () => {
    const actual = fixture(representation), evidence = actual.evidence;
    const read = () => decodeWorkspaceOperationMixedSourceEvidenceV5(structuredClone(evidence));
    assert(hashes(read).calls > 0); assert(hashes(read).calls > 0, 'Default callers retain cold mutable-input validation.');
    await withMixedSourceEvidenceValidationReuse(async () => {
      const cold = hashes(read), warm = hashes(read);
      assert(cold.calls > 0); assert.equal(warm.calls, 0, 'Identical captured historical facts avoid repeated hashes inside this one frame.');
      assert.deepEqual(warm.value, cold.value); assert.deepEqual(warm.value, evidence);
      assert.notEqual(warm.value, cold.value); assert.notEqual(warm.value.nativeComponent, cold.value.nativeComponent);
      assert(Object.isFrozen(warm.value) && Object.isFrozen(warm.value.nativeComponent));
      await withMixedSourceEvidenceValidationReuse(async () => { assert(hashes(read).calls > 0); assert.equal(hashes(read).calls, 0); });
      assert.equal(hashes(read).calls, 0, 'Nested frames cannot evict or adopt the outer frame.');
      const changed = structuredClone(evidence);
      Reflect.set(changed.nativeOrdinarySources4[0].inventory.metadata, 'title', 'Tampered original');
      const outside = await withMixedSourceEvidenceValidationReuse(async () => failure(() => decodeWorkspaceOperationMixedSourceEvidenceV5(changed)));
      assert.equal(failure(() => decodeWorkspaceOperationMixedSourceEvidenceV5(changed)), outside);
      let traps = 0;
      const getter = { ...evidence }; Object.defineProperty(getter, 'nativeComponent', { enumerable: true, get() { traps++; throw Error('Never call this getter'); } });
      const proxy = new Proxy(evidence, { get() { traps++; throw Error('Proxy'); }, ownKeys() { traps++; throw Error('Proxy'); } });
      failure(() => decodeWorkspaceOperationMixedSourceEvidenceV5(getter)); failure(() => decodeWorkspaceOperationMixedSourceEvidenceV5(proxy)); assert.equal(traps, 0);
      const descriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify'); assert(descriptor && typeof descriptor.value === 'function');
      let outsideReads = 0, insideReads = 0, measuringInside = false;
      try {
        Object.defineProperty(JSON, 'stringify', { configurable: true, enumerable: descriptor.enumerable,
          get() { if (measuringInside) insideReads++; else outsideReads++; return descriptor.value; } });
        await withMixedSourceEvidenceValidationReuse(async () => { assert(hashes(read).calls > 0); });
        measuringInside = true; assert(hashes(read).calls > 0);
        assert.equal(insideReads, outsideReads, 'The cache guard must not invoke a foreign stringify getter.');
      } finally { Object.defineProperty(JSON, 'stringify', descriptor); }
      assert.equal(hashes(read).calls, 0);
      if (representation !== 'plain_text') {
        const attrs = getNativeInspectionSchema().marks.link.spec.attrs!, href = Object.getOwnPropertyDescriptor(attrs, 'href'); assert(href);
        assert(Reflect.deleteProperty(attrs, 'href'));
        try {
          const warmFailure = failure(read);
          const coldFailure = await withMixedSourceEvidenceValidationReuse(async () => failure(read)); assert.equal(warmFailure, coldFailure);
        } finally { Object.defineProperty(attrs, 'href', href); }
        assert.equal(hashes(read).calls, 0);
      }
      // A historical stamp never replaces current private Yjs-byte inspection.
      const state = actual.observation.privateNativeStates[0], before = state.yjsState.slice();
      try { state.yjsState[0] ^= 0xff; failure(() => assertWorkspaceOperationMixedSourceEvidenceV5Current(evidence, actual.observation, actual.scope)); }
      finally { state.yjsState.set(before); }
      assertWorkspaceOperationMixedSourceEvidenceV5Current(evidence, actual.observation, actual.scope);
    });
    assert(hashes(read).calls > 0, 'The frame retains no byte-keyed validation after its end.');
    let release!: () => void, child: Promise<void> | undefined; const gate = new Promise<void>(resolve => { release = resolve; });
    await withMixedSourceEvidenceValidationReuse(async () => { read(); child = gate.then(() => { assert(hashes(read).calls > 0); }); });
    release(); assert(child); await child;
  });
  const samples: WorkspaceOperationMixedSourceEvidenceV5[] = Array.from({ length: 5 }, (_, index) => workspaceOperationMixedSourceEvidenceV5Fixture({ workspaceId: `validation-reuse-${index}`, raw: [] }).evidence);
  await withMixedSourceEvidenceValidationReuse(async () => {
    for (const sample of samples) assert(hashes(() => decodeWorkspaceOperationMixedSourceEvidenceV5(structuredClone(sample))).calls > 0);
    assert(hashes(() => decodeWorkspaceOperationMixedSourceEvidenceV5(structuredClone(samples[0]))).calls > 0, 'The fifth entry evicts the first.');
    const oversized = { ...samples[0], oversized: 'x'.repeat(8 * 1024 * 1024) };
    assert.equal(failure(() => decodeWorkspaceOperationMixedSourceEvidenceV5(oversized)), 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  });
  const primary = new Error('Original operation failure'), originalInfo = console.info;
  try {
    console.info = () => { throw Error('Diagnostic sink failed'); };
    await assert.rejects(withMixedSourceEvidenceValidationReuse(async () => { throw primary; }), error => error === primary);
  } finally { console.info = originalInfo; }
  console.log(JSON.stringify({ suite: 'mixed-source-evidence-validation-reuse', representations: 3, passed: true,
    freshInputsCaptured: true, currentBytesNeverCached: true, explicitOneAttemptLifetime: true, executionAuthority: false }));
}
