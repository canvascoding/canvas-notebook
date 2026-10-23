import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { decodePhysicalMarkdownSourceEvidenceV5, type PhysicalMarkdownSourceEvidenceV5 } from '../files/workspace-operation-mixed-source-evidence-v5';
import { inspectOriginalPhysicalLinksV3, inspectOriginalPhysicalLinksV4,
  type OriginalPhysicalLinkInventory, type OriginalPhysicalLinkInventoryV4 } from './workspace-physical-link-inventory';
import { nativeLinkJsonProof as proof } from './workspace-native-link-inventory';
import { RawHtmlSourceBindingError } from './workspace-raw-html-source-binding';

/** Actual parser4 source data. This grants no FD, namespace, import or SQL authority. */
export type RawHtmlSourceBindingV2 = Readonly<{ version: 2; sourcePath: string; sourceProof4: string;
  original4: PhysicalMarkdownSourceEvidenceV5; bindingProof: string }>;
function fail(): never { throw new RawHtmlSourceBindingError('RAW_HTML_BINDING_CHANGED'); }
function capture<T>(input: unknown): T {
  return captureWorkspaceOperationNativePlanData(input, fail, 16 * 1024 * 1024) as T;
}
function exact(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function supported(source: PhysicalMarkdownSourceEvidenceV5): void {
  if (source.parserVersion !== 4 || source.coverage.complete !== (source.coverage.gaps.length === 0)
    || source.coverage.gaps.some(gap => gap.code !== 'uninspected-html')
    || source.htmlInspection.occurrences.some(row => row.fullyInspected !== true)) {
    throw new RawHtmlSourceBindingError('RAW_HTML_SOURCE_UNSUPPORTED');
  }
}
export function decodeRawHtmlSourceBindingV2(input: unknown, sourceInput: PhysicalMarkdownSourceEvidenceV5): RawHtmlSourceBindingV2 {
  const source4 = decodePhysicalMarkdownSourceEvidenceV5(sourceInput), value = capture<RawHtmlSourceBindingV2>(input);
  exact(value, ['version', 'sourcePath', 'sourceProof4', 'original4', 'bindingProof']);
  supported(source4);
  const original = decodePhysicalMarkdownSourceEvidenceV5(value.original4);
  const { bindingProof, ...body } = value;
  if (value.version !== 2 || value.sourcePath !== source4.path || value.sourceProof4 !== source4.physicalSourceProof
    || !equal(original, source4) || typeof bindingProof !== 'string' || !/^[a-f0-9]{64}$/u.test(bindingProof)
    || proof(body) !== bindingProof) fail();
  return freeze(value);
}
/** Reparse actual private bytes in both their declared source grammar and4.
 * Parser3 supplied by the observation is checked as3, never relabelled as4. */
export function captureRawHtmlSourceBindingV2(input: Readonly<{
  original: OriginalPhysicalLinkInventory | OriginalPhysicalLinkInventoryV4; source4: PhysicalMarkdownSourceEvidenceV5;
}>): RawHtmlSourceBindingV2 {
  exact(input, ['original', 'source4']);
  if (!input.original || types.isProxy(input.original) || Object.getPrototypeOf(input.original) !== Object.prototype) fail();
  const facts: Record<string, unknown> = {};
  let binary: unknown;
  for (const key of Reflect.ownKeys(input.original)) {
    if (typeof key !== 'string') fail();
    const descriptor = Object.getOwnPropertyDescriptor(input.original, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    if (key === 'originalBytes') binary = descriptor.value; else facts[key] = descriptor.value;
  }
  if (!binary || typeof binary !== 'object' || types.isProxy(binary) || !ArrayBuffer.isView(binary)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(binary))
    || ['buffer', 'byteLength', 'byteOffset', 'constructor'].some(key => Object.hasOwn(binary, key))) fail();
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const size = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(binary) as number;
  const backing = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(binary) as ArrayBuffer;
  if (!types.isArrayBuffer(backing) || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || size > 4 * 1024 * 1024) fail();
  const bytes = new Uint8Array(size); Uint8Array.prototype.set.call(bytes, binary as Uint8Array);
  const source4 = decodePhysicalMarkdownSourceEvidenceV5(input.source4), supplied = capture<typeof facts>(facts);
  const options = { workspaceId: source4.workspaceId, organizationId: source4.organizationId, path: source4.path,
    authority: source4.authority, filesystemIdentity: source4.physical.filesystemIdentity, bytes };
  const declared = supplied.parserVersion === 3 ? inspectOriginalPhysicalLinksV3(options)
    : supplied.parserVersion === 4 ? inspectOriginalPhysicalLinksV4(options) : fail();
  const { originalBytes: _declaredBytes, ...declaredFacts } = declared;
  if (!equal(supplied, declaredFacts) || size !== source4.physical.byteLength) fail();
  const { originalBytes: _actualBytes, ...original4 } = inspectOriginalPhysicalLinksV4(options);
  if (!equal(original4, source4)) fail();
  const body = { version: 2 as const, sourcePath: source4.path, sourceProof4: source4.physicalSourceProof, original4 };
  return decodeRawHtmlSourceBindingV2({ ...body, bindingProof: proof(body) }, source4);
}
