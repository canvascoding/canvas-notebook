import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import type { PhysicalNativeImportBindingV1 } from './physical-native-import-binding';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { decodeNativeInventoryV4Facts } from '../files/workspace-operation-native-source-evidence';
import type { PhysicalMarkdownSourceEvidenceV5 } from '../files/workspace-operation-mixed-source-evidence-v5';
import { inspectOriginalPhysicalLinksV3, type OriginalPhysicalLinkInventory } from './workspace-physical-link-inventory';
import { inspectPersistedDocumentLinksV4, nativeLinkJsonProof as proof,
  type NativeDocumentLinkInventoryV3, type NativeDocumentLinkInventoryV4 } from './workspace-native-link-inventory';

/** C1 records BOTH actual grammars. Neither stored grammar is relabelled. The
 * original importer still receives genuine parser3 facts and private bytes. */
export type RawHtmlSourceBindingV1 = Readonly<{
  version: 1; sourcePath: string; ordinarySourceProof4: string;
  original3: Readonly<Omit<OriginalPhysicalLinkInventory, 'originalBytes'>>;
  bindingProof: string;
}>;
export type RawHtmlNativeBindingV1 = Readonly<{
  version: 1; sourceBindingProof: string; legacyBindingProof: string;
  inventory4: NativeDocumentLinkInventoryV4; bindingProof: string;
}>;
export class RawHtmlSourceBindingError extends Error {
  readonly status = 409;
  constructor(readonly code: 'RAW_HTML_BINDING_INVALID' | 'RAW_HTML_BINDING_CHANGED'
    | 'RAW_HTML_SOURCE_UNSUPPORTED') { super(code); this.name = 'RawHtmlSourceBindingError'; }
}
function fail(code: RawHtmlSourceBindingError['code'] = 'RAW_HTML_BINDING_INVALID'): never {
  throw new RawHtmlSourceBindingError(code);
}
function capture<T>(input: unknown): T {
  return captureWorkspaceOperationNativePlanData(input, () => fail(), 16 * 1024 * 1024) as T;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  for (const key of keys) {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) fail();
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** No lossy compatibility adapter: every ordinary fact, ordered occurrence,
 * UTF16/UTF8 range, literal, alias and physical ID must be exactly equal. */
function assertSourceParity(original3: RawHtmlSourceBindingV1['original3'], source4: PhysicalMarkdownSourceEvidenceV5): void {
  if (original3.parserVersion !== 3 || source4.parserVersion !== 4
    || !original3.coverage.complete || original3.coverage.gaps.length
    || !source4.coverage.complete || source4.coverage.gaps.length
    || source4.htmlInspection.occurrences.length) fail('RAW_HTML_SOURCE_UNSUPPORTED');
  const { parserVersion: _three, physicalSourceProof: sourceProof3, ...facts3 } = original3;
  const { parserVersion: _four, physicalSourceProof: sourceProof4, htmlInspection: _html, ...facts4 } = source4;
  if (!equal(facts3, facts4) || !digest(sourceProof3) || !digest(sourceProof4)
    || proof({ ...facts3, parserVersion: 3, observedOriginalByteHash: original3.physical.byteHash }) !== sourceProof3) {
    fail('RAW_HTML_BINDING_CHANGED');
  }
}

/** Historical data only; source4 must itself come from the strict E5 decoder.
 * Current capture below repeats parser3 on the actual original bytes. */
export function decodeRawHtmlSourceBindingV1(input: unknown,
  source4Input: PhysicalMarkdownSourceEvidenceV5): RawHtmlSourceBindingV1 {
  const source4 = capture<PhysicalMarkdownSourceEvidenceV5>(source4Input), value = capture<RawHtmlSourceBindingV1>(input);
  exact(value, ['version', 'sourcePath', 'ordinarySourceProof4', 'original3', 'bindingProof']);
  if (value.version !== 1 || value.sourcePath !== source4.path || value.ordinarySourceProof4 !== source4.physicalSourceProof
    || !digest(value.bindingProof)) fail();
  assertSourceParity(value.original3, source4);
  const { bindingProof, ...body } = value;
  if (proof(body) !== bindingProof) fail(); return freeze(value);
}

/** Raw bytes are read only through genuine intrinsic typed-array storage; no
 * caller getter or iterator runs. This is pure evidence, never import authority. */
export function captureRawHtmlSourceBindingV1(input: Readonly<{ original: OriginalPhysicalLinkInventory;
  source4: PhysicalMarkdownSourceEvidenceV5 }>): RawHtmlSourceBindingV1 {
  exact(input, ['original', 'source4']);
  if (!input.original || types.isProxy(input.original) || Object.getPrototypeOf(input.original) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(input.original, 'originalBytes');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  const bytes: unknown = descriptor.value;
  if (!bytes || typeof bytes !== 'object' || types.isProxy(bytes) || !ArrayBuffer.isView(bytes)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(bytes))
    || ['buffer', 'byteLength', 'byteOffset', 'constructor'].some(key => Object.hasOwn(bytes, key))) fail();
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(bytes) as number;
  const backing = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(bytes) as ArrayBuffer;
  if (!types.isArrayBuffer(backing) || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype
    || length > 4 * 1024 * 1024) fail();
  const copy = new Uint8Array(length); Uint8Array.prototype.set.call(copy, bytes as Uint8Array);
  // Capture descriptors before reading any source fact.
  const facts: Record<string, unknown> = {};
  if (types.isProxy(input.original) || Object.getPrototypeOf(input.original) !== Object.prototype) fail();
  for (const key of Reflect.ownKeys(input.original)) {
    if (typeof key !== 'string') fail();
    const item = Object.getOwnPropertyDescriptor(input.original, key);
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) fail();
    if (key !== 'originalBytes') facts[key] = item.value;
  }
  const supplied = capture<RawHtmlSourceBindingV1['original3']>(facts), source4 = capture<PhysicalMarkdownSourceEvidenceV5>(input.source4);
  const parsed = inspectOriginalPhysicalLinksV3({ workspaceId: source4.workspaceId, organizationId: source4.organizationId,
    path: source4.path, authority: source4.authority, filesystemIdentity: source4.physical.filesystemIdentity, bytes: copy });
  const { originalBytes: _private, ...original3 } = parsed;
  if (!equal(supplied, original3) || copy.length !== source4.physical.byteLength) fail('RAW_HTML_BINDING_CHANGED');
  assertSourceParity(original3, source4);
  const body = { version: 1 as const, sourcePath: source4.path, ordinarySourceProof4: source4.physicalSourceProof, original3 };
  return decodeRawHtmlSourceBindingV1({ ...body, bindingProof: proof(body) }, source4);
}

function assertNativeParity(inventory3: NativeDocumentLinkInventoryV3, inventory4: NativeDocumentLinkInventoryV4): void {
  const { parserVersion: _three, ...three } = inventory3, { parserVersion: _four, ...four } = inventory4;
  if (inventory3.parserVersion !== 3 || inventory4.parserVersion !== 4
    || !inventory3.coverage.complete || inventory3.coverage.gaps.length || !inventory4.coverage.complete
    || inventory4.coverage.gaps.length || !equal(three, four)) fail('RAW_HTML_SOURCE_UNSUPPORTED');
}
function assertLegacyBinding(binding: PhysicalNativeImportBindingV1, source: RawHtmlSourceBindingV1): void {
  exact(binding, ['version', 'source', 'receipt', 'nativeInventory', 'nativeBinaryHash', 'nativeVectorHash', 'links', 'bindingProof']);
  const original = source.original3, target = binding.receipt.target, inventory = binding.nativeInventory;
  if (binding.version !== 1 || !equal(binding.source, { workspaceId: original.workspaceId, organizationId: original.organizationId,
    path: original.path, physicalSourceProof: original.physicalSourceProof, filesystemIdentity: original.physical.filesystemIdentity,
    sourceHash: original.physical.byteHash, sourceBytes: original.physical.byteLength })
    || binding.receipt.version !== 1 || binding.receipt.sourceHash !== original.physical.byteHash
    || binding.receipt.sourceBytes !== original.physical.byteLength || binding.receipt.checkpointRequired !== true
    || !digest(binding.nativeBinaryHash) || !digest(binding.nativeVectorHash) || !digest(binding.bindingProof)
    || !equal(inventory.document, { documentId: target.documentId, workspaceId: target.workspaceId,
      organizationId: target.organizationId, path: target.path, lifecycleGeneration: target.lifecycleGeneration,
      representation: target.representation, schemaVersion: target.schemaVersion })
    || inventory.version.stateProof !== target.initialStateProof || inventory.version.documentSequence !== 0
    || inventory.version.persistedAt !== target.persistedAt || !Array.isArray(binding.links)
    || binding.links.length !== original.links.length) fail();
  const local = inventory.links.filter(link => link.classification === 'local' || link.classification === 'anchor-only' && link.kind === 'wiki');
  if (local.length !== original.links.length) fail();
  const seen = new Set<string>();
  for (const [index, row] of binding.links.entries()) {
    exact(row, ['physicalLinkId', 'nativeLinkId', 'reference', 'occurrenceProof']);
    const native = local[index];
    if (row.physicalLinkId !== original.links[index].physicalLinkId || row.nativeLinkId !== native.id
      || !equal(row.reference, native.ref) || !digest(row.occurrenceProof) || seen.has(row.physicalLinkId)) fail();
    seen.add(row.physicalLinkId);
  }
  const { bindingProof, ...body } = binding;
  if (proof(body) !== bindingProof) fail();
}
/** Persist alongside the real initial raw-target journal step. It certifies
 * actual4 from the SAME imported B1 bytes; Birth1 remains parser3 forever. */
export function captureRawHtmlNativeBindingV1(input: Readonly<{ source: RawHtmlSourceBindingV1;
  binding: PhysicalNativeImportBindingV1; state: PersistedCollaborationState }>): RawHtmlNativeBindingV1 {
  exact(input, ['source', 'binding', 'state']);
  const source = capture<RawHtmlSourceBindingV1>(input.source), binding = capture<PhysicalNativeImportBindingV1>(input.binding);
  if (!input.state || types.isProxy(input.state) || Object.getPrototypeOf(input.state) !== Object.prototype) fail();
  const inventory4 = inspectPersistedDocumentLinksV4(input.state);
  assertLegacyBinding(binding, source);
  assertNativeParity(binding.nativeInventory, inventory4);
  const body = { version: 1 as const, sourceBindingProof: source.bindingProof,
    legacyBindingProof: binding.bindingProof, inventory4 };
  return freeze(capture({ ...body, bindingProof: proof(body) }));
}
export function decodeRawHtmlNativeBindingV1(input: unknown, sourceInput: RawHtmlSourceBindingV1,
  bindingInput: PhysicalNativeImportBindingV1): RawHtmlNativeBindingV1 {
  const source = capture<RawHtmlSourceBindingV1>(sourceInput), binding = capture<PhysicalNativeImportBindingV1>(bindingInput);
  const value = capture<RawHtmlNativeBindingV1>(input);
  exact(value, ['version', 'sourceBindingProof', 'legacyBindingProof', 'inventory4', 'bindingProof']);
  if (value.version !== 1 || value.sourceBindingProof !== source.bindingProof
    || value.legacyBindingProof !== binding.bindingProof || !digest(value.bindingProof)) fail();
  assertLegacyBinding(binding, source);
  decodeNativeInventoryV4Facts(value.inventory4);
  assertNativeParity(binding.nativeInventory, value.inventory4);
  const { bindingProof, ...body } = value;
  if (proof(body) !== bindingProof) fail(); return freeze(value);
}
