import assert from 'node:assert/strict';

import { inspectPersistedDocumentLinks, inspectPersistedDocumentLinksV4 } from '../app/lib/markdown/workspace-native-link-inventory';
import { decodeNativeInventoryV4Facts, WorkspaceOperationNativeSourceEvidenceError }
  from '../app/lib/files/workspace-operation-native-source-evidence';
import { workspacePathImportPreparationFixture } from './workspace-path-import-preparation-plan-test';
import { v3EvidenceFixture } from './workspace-operation-native-source-evidence-v3-test';

/** Facts-only decoder checks. Actual mutation authority and storage are outside
 * this suite; the fixtures contain real Yjs state and native snapshot proofs. */
export function workspaceNativeInventoryV4CodecTest(): void {
  let groups = 0;
  const fixture = (text: string) => workspacePathImportPreparationFixture({ raw: [], native: [['source.md', text]] });
  const reject = (action: () => unknown) => assert.throws(action, error =>
    error instanceof WorkspaceOperationNativeSourceEvidenceError && error.code === 'NATIVE_SOURCE_EVIDENCE_INVALID');
  const input = fixture('\uFEFF# Heading\r\n\r\n[[Note|<img src="literal.png">]] [Link](next.md)\r\n');
  const state = input.observation.privateNativeStates[0];
  const inventory = inspectPersistedDocumentLinksV4(state);
  const before = JSON.stringify(inventory), bytes = Buffer.from(state.yjsState);
  const decoded = decodeNativeInventoryV4Facts(JSON.parse(before));
  assert.deepEqual(decoded, inventory);
  assert(Object.isFrozen(decoded) && Object.isFrozen(decoded.links[0].ref));
  assert.equal(decoded.metadata.title, 'Heading');
  assert.equal(decoded.links.length, 2);
  assert.equal(JSON.stringify(inventory), before);
  assert.deepEqual(Buffer.from(state.yjsState), bytes);
  groups++;

  // Historical grammar cannot become grammar 4 by entering this decoder.
  reject(() => decodeNativeInventoryV4Facts(inspectPersistedDocumentLinks(state)));
  for (const change of [
    (value: typeof inventory) => { value.parserVersion = 3 as 4; },
    (value: typeof inventory) => { value.contractVersion = 3 as 2; },
    (value: typeof inventory) => { value.document.documentId = ''; },
    (value: typeof inventory) => { value.document.path = '../outside.md'; },
    (value: typeof inventory) => { value.document.lifecycleGeneration = -1; },
    (value: typeof inventory) => { value.document.schemaVersion++; },
    (value: typeof inventory) => { value.version.stateProof = 'not-a-proof'; },
    (value: typeof inventory) => { value.version.stateVector = 'invalid?'; },
    (value: typeof inventory) => { value.version.documentSequence = -0; },
  ]) { const value = structuredClone(inventory); change(value); reject(() => decodeNativeInventoryV4Facts(value)); }
  groups++;

  // No hidden fields, executable accessors or proxy traps may participate.
  const extra = { ...inventory, executionReady: true };
  reject(() => decodeNativeInventoryV4Facts(extra));
  let calls = 0;
  const getter = structuredClone(inventory);
  Object.defineProperty(getter, 'version', { enumerable: true, get() { calls++; return inventory.version; } });
  reject(() => decodeNativeInventoryV4Facts(getter));
  const proxy = new Proxy(inventory, { getPrototypeOf() { calls++; return Object.prototype; },
    ownKeys() { calls++; return Reflect.ownKeys(inventory); } });
  reject(() => decodeNativeInventoryV4Facts(proxy));
  assert.equal(calls, 0);
  groups++;

  // Stored references remain strictly shaped and internally bound to link IDs,
  // ordinals, original ranges and expected source text.
  for (const change of [
    (value: typeof inventory) => { value.links[0].id = 'forged'; },
    (value: typeof inventory) => { value.links[0].cloneLocator.ordinal++; },
    (value: typeof inventory) => { value.links.push(structuredClone(value.links[0])); },
    (value: typeof inventory) => { value.metadata.headings[0].depth = 7; },
    (value: typeof inventory) => {
      const ref = value.links[0].ref; assert.equal(ref.kind, 'plain-target');
      if (ref.kind === 'plain-target') ref.targetStart++;
    },
    (value: typeof inventory) => {
      const ref = value.links[0].ref; assert.equal(ref.kind, 'plain-target');
      if (ref.kind === 'plain-target') ref.text.startAnchor = 'invalid?';
    },
  ]) { const value = structuredClone(inventory); change(value); reject(() => decodeNativeInventoryV4Facts(value)); }
  groups++;

  // New HTML gaps are independently inspected under the strict parser-4 rule.
  for (const text of ['<img src="asset.png">', '<custom-element></custom-element>',
    '[<custom-element resource="opaque.png">Label</custom-element>](next.md)']) {
    const actual = inspectPersistedDocumentLinksV4(fixture(text).observation.privateNativeStates[0]);
    assert.equal(actual.coverage.complete, false);
    assert.deepEqual(decodeNativeInventoryV4Facts(actual), actual);
    const hidden = structuredClone(actual); hidden.coverage.complete = true;
    reject(() => decodeNativeInventoryV4Facts(hidden));
  }
  const opaque = inspectPersistedDocumentLinksV4(fixture('<custom-element></custom-element>').observation.privateNativeStates[0]);
  for (const targets of [null, []]) {
    const value = structuredClone(opaque);
    Object.assign(value.coverage.gaps[0], { htmlTargets: targets });
    reject(() => decodeNativeInventoryV4Facts(value));
  }
  const safe = structuredClone(opaque);
  safe.coverage.gaps[0].raw = '<div>Safe</div>';
  reject(() => decodeNativeInventoryV4Facts(safe));
  groups++;

  // Rich source facts retain actual marks/attributes and representation policy.
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const actual = inspectPersistedDocumentLinksV4(v3EvidenceFixture(representation).observation.privateNativeStates[0]);
    assert.deepEqual(decodeNativeInventoryV4Facts(actual), actual);
    const foreign = structuredClone(actual); foreign.document.representation = 'plain_text';
    reject(() => decodeNativeInventoryV4Facts(foreign));
  }
  groups++;

  assert.equal(groups, 6);
  console.log(JSON.stringify({ suite: 'native-inventory-v4-codec', groups, factsOnly: true, executionAuthority: false }));
}
