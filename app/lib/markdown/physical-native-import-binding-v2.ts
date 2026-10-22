import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { MARKDOWN_FILE_IMPORT_LIMIT, prepareMarkdownFileImport } from '../collaboration/markdown-file-import';
import type { MarkdownFileImportReceipt } from '../collaboration/markdown-file-import-persistence';
import { richMarkdownFromYDoc } from '../collaboration/markdown-state';
import { serializeCanonicalText, type PersistedCollaborationState } from '../collaboration/persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { Y } from '../collaboration/server-runtime';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { decodeNativeInventoryV4Facts } from '../files/workspace-operation-native-source-evidence';
import { decodePhysicalMarkdownSourceEvidenceV5, type PhysicalMarkdownSourceEvidenceV5 } from '../files/workspace-operation-mixed-source-evidence-v5';
import type { NativeDocumentLink, NativeDocumentLinkInventory } from './workspace-link-contract-v2';
import { inspectPersistedDocumentLinksV4, nativeLinkJsonProof as proof, type NativeDocumentLinkInventoryV4 } from './workspace-native-link-inventory';
import { prepareNativeLinkInverseV4, prepareNativeLinkMutationsV4 } from './workspace-native-link-mutations';
import { inspectOriginalPhysicalLinksV4, type OriginalPhysicalLink, type OriginalPhysicalLinkInventoryV4 } from './workspace-physical-link-inventory';
import { inspectWorkspaceMarkdownHtmlV4, type WorkspaceMarkdownHtmlInspectionV4 } from './workspace-local-link-parser';
import { inspectWorkspaceStaticHtmlLinks } from './workspace-html-link-safety';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';

/** Import identity/syntax evidence only. This does not assess a namespace
 * operation, hold a current FD, authenticate a receipt, grant SQL or import. */
export type PhysicalNativeImportBindingInputV2 = Readonly<{
  original: OriginalPhysicalLinkInventoryV4; receipt: MarkdownFileImportReceipt;
  state: PersistedCollaborationState; lineageId: string;
}>;
export type PhysicalNativeImportBindingV2 = Readonly<{
  version: 2; original4: PhysicalMarkdownSourceEvidenceV5;
  source: Readonly<{ parserVersion: 4; workspaceId: string; organizationId: string | null; path: string;
    physicalSourceProof: string; filesystemIdentity: string; sourceHash: string; sourceBytes: number }>;
  receipt: MarkdownFileImportReceipt; nativeInventory: NativeDocumentLinkInventoryV4;
  nativeBinaryHash: string; nativeVectorHash: string;
  html: Readonly<{ version: 1; original: WorkspaceMarkdownHtmlInspectionV4; imported: WorkspaceMarkdownHtmlInspectionV4;
    originalSourceProof: string; nativeSourceProof: string }>;
  links: ReadonlyArray<Readonly<{ physicalLinkId: string; nativeLinkId: string;
    reference: NativeDocumentLink['ref']; occurrenceProof: string }>>;
  bindingProof: string;
}>;

const MAX_LINKS = 20_000;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_VECTOR_BYTES = 1024 * 1024;
const MAX_WORK_BYTES = 128 * 1024 * 1024;
// The shared adapter currently filters its inventory for each recipe. Charge
// this actual quadratic validation work before entering either rehearsal.
const MAX_LINK_PAIR_CHECKS = 1_000_000;
const physicalKeys = ['physicalSourceVersion', 'parserVersion', 'source', 'workspaceId', 'organizationId', 'path', 'authority',
  'physical', 'originalBytes', 'encoding', 'hasBom', 'lineEndings', 'frontmatterPrefix', 'metadata', 'links', 'coverage',
  'htmlInspection', 'applicability', 'executionReady', 'physicalSourceProof'] as const;
const stateKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'lifecycleGeneration', 'schemaVersion',
  'yjsState', 'stateVector', 'documentSequence', 'persistedAt', 'checkpointedAt', 'checkpointSequence', 'canonicalHash',
  'serializedHash', 'newlineStyle', 'hasBom', 'degraded', 'status', 'projectionError', 'projectionFinalized'] as const;
const targetKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration',
  'newlineStyle', 'hasBom', 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;

export class PhysicalNativeImportBindingV2Error extends Error {
  readonly status = 409;
  constructor(readonly code: 'INVALID' | 'CHANGED' | 'UNSUPPORTED') {
    super(`Physical to native import binding is unavailable: ${code}.`);
    this.name = 'PhysicalNativeImportBindingV2Error';
  }
}
function physicalNativeV2Fail(code: PhysicalNativeImportBindingV2Error['code'] = 'INVALID'): never {
  throw new PhysicalNativeImportBindingV2Error(code);
}
function physicalNativeV2Capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => physicalNativeV2Fail(reason === 'too-large' ? 'UNSUPPORTED' : 'INVALID'), 16 * 1024 * 1024);
}
/** Inspect descriptors before reading input values; getters/Proxies never run. */
function physicalNativeV2Object(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return physicalNativeV2Fail();
  const names = Reflect.ownKeys(input);
  if (names.length > keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return physicalNativeV2Fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor && optional.includes(key)) continue;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return physicalNativeV2Fail();
    result[key] = descriptor.value;
  }
  return result;
}
function physicalNativeV2Binary(input: unknown, maximum: number): Uint8Array {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !ArrayBuffer.isView(input)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
    || ['buffer', 'byteLength', 'byteOffset', 'constructor'].some(key => Object.hasOwn(input, key))) return physicalNativeV2Fail();
  const length = intrinsicByteLength.call(input) as number;
  if (!Number.isSafeInteger(length) || length > maximum) return physicalNativeV2Fail('UNSUPPORTED');
  if (Object.getPrototypeOf(intrinsicBuffer.call(input)) !== ArrayBuffer.prototype) return physicalNativeV2Fail();
  const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, input as Uint8Array); return bytes;
}
function physicalNativeV2Freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) physicalNativeV2Freeze(child); Object.freeze(value); }
  return value;
}
function physicalNativeV2ReceiptIdentity(input: unknown, state: PersistedCollaborationState, lineageId: unknown): MarkdownFileImportReceipt {
  const receipt = physicalNativeV2Object(physicalNativeV2Capture(input), ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired']);
  const target = physicalNativeV2Object(receipt.target, targetKeys);
  if (receipt.version !== 1 || receipt.checkpointRequired !== true || typeof receipt.operationId !== 'string'
    || receipt.operationId.length < 1 || receipt.operationId.length > 256 || receipt.operationId.trim() !== receipt.operationId
    || /[\u0000-\u001f\u007f]/u.test(receipt.operationId)
    || ![receipt.requestFingerprint, receipt.sourceHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
    || !Number.isSafeInteger(receipt.sourceBytes) || Number(receipt.sourceBytes) < 0 || Number(receipt.sourceBytes) > MARKDOWN_FILE_IMPORT_LIMIT
    || ![target.documentId, target.workspaceId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256
      && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value))
    || target.organizationId !== null && (typeof target.organizationId !== 'string' || !target.organizationId
      || target.organizationId.length > 256 || target.organizationId.trim() !== target.organizationId || /[\u0000-\u001f\u007f]/u.test(target.organizationId))
    || typeof lineageId !== 'string' || !lineageId || lineageId.length > 256 || lineageId.trim() !== lineageId
    || /[\u0000-\u001f\u007f]/u.test(lineageId) || target.lineageId !== lineageId
    || !['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration', 'newlineStyle', 'hasBom']
      .every(key => Reflect.get(state, key) === target[key])
    || state.lifecycleGeneration !== 1 || state.documentSequence !== 0 || target.initialSequence !== 0
    || !Number.isSafeInteger(target.persistedAt) || Number(target.persistedAt) < 0 || target.persistedAt !== state.persistedAt
    || typeof target.initialStateProof !== 'string' || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(target.initialStateProof)) return physicalNativeV2Fail('CHANGED');
  return receipt as MarkdownFileImportReceipt;
}
function physicalNativeV2Serialize(state: PersistedCollaborationState): string {
  return inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => serializeCanonicalText(
    snapshot.content.kind === 'plain_text' ? snapshot.content.text : richMarkdownFromYDoc(doc), state));
}
/** A physical UTF16 boundary is evidence only, never a Yjs relative position. */
function physicalNativeV2CanonicalOffsets(source: string, offsets: readonly number[]): Map<number, number> {
  const result = new Map<number, number>(); let previous = 0, canonical = 0;
  for (const offset of [...new Set(offsets)].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length
      || /[\uD800-\uDBFF]/u.test(source.charAt(offset - 1)) && /[\uDC00-\uDFFF]/u.test(source.charAt(offset))
      || source.charAt(offset - 1) === '\r' && source.charAt(offset) === '\n') return physicalNativeV2Fail();
    let part = source.slice(previous, offset);
    if (previous === 0 && part.startsWith('\uFEFF')) part = part.slice(1);
    canonical += part.replace(/\r\n/gu, '\n').length;
    result.set(offset, canonical); previous = offset;
  }
  return result;
}
function physicalNativeV2LinkMeaning(link: OriginalPhysicalLink | NativeDocumentLink): unknown {
  return { kind: link.kind, syntax: link.syntax, literal: 'targetLiteral' in link ? link.targetLiteral : link.literal,
    targetPathText: link.targetPathText, fragment: link.fragment, alias: link.alias, embed: link.embed };
}
function physicalNativeV2ProbeTarget(link: NativeDocumentLink, probe: string): string {
  if (link.ref.kind !== 'node-attribute' || link.ref.attribute !== 'target') return probe;
  if (!link.ref.expected.startsWith(link.literal) || link.ref.expected.slice(link.literal.length)
    && !link.ref.expected.slice(link.literal.length).startsWith('|')) return physicalNativeV2Fail('UNSUPPORTED');
  return probe + link.ref.expected.slice(link.literal.length);
}
/** A single batch uses unique probes at disjoint physical ranges. Exact whole
 * forward/inverse bytes certify each ordered candidate, including duplicates;
 * no alternative candidate search or repeated whole-document serialization. */
function physicalNativeV2Rehearse(state: PersistedCollaborationState, inventory: Pick<NativeDocumentLinkInventory, 'document' | 'version'>, native: readonly NativeDocumentLink[],
  physical: readonly OriginalPhysicalLink[], source: string, canonical: string, sourceProof: string): string[] {
  if (!physical.length) return [];
  const prefix = `canvas-import-proof-${sourceProof.slice(0, 32)}-`;
  if (source.includes(prefix)) return physicalNativeV2Fail('UNSUPPORTED');
  const offsets = physicalNativeV2CanonicalOffsets(source, physical.flatMap(link => [link.targetRange.startUtf16, link.targetRange.endUtf16]));
  const parts: string[] = [], probes: string[] = []; let position = 0;
  for (const [index, link] of physical.entries()) {
    const start = offsets.get(link.targetRange.startUtf16)!, end = offsets.get(link.targetRange.endUtf16)!;
    if (start < position || end <= start || canonical.slice(start, end) !== link.targetLiteral) return physicalNativeV2Fail('CHANGED');
    const probe = `${prefix}${index}.md`;
    parts.push(canonical.slice(position, start), probe); probes.push(probe); position = end;
  }
  parts.push(canonical.slice(position));
  const expected = serializeCanonicalText(parts.join(''), state);
  const operationId = 'physical-native-import-proof:batch';
  const prepared = prepareNativeLinkMutationsV4({ state, operationId, recipes: native.map((link, index) => ({
    linkId: link.id, source: inventory.document, sourceVersion: inventory.version, reference: link.ref,
    destinationWorkspaceId: state.workspaceId, sourcePathAfter: state.path,
    cloneSelection: null, action: 'rewrite' as const, nextValue: physicalNativeV2ProbeTarget(link, probes[index]),
    expectedTargetIdentity: probes[index] })) });
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, state.yjsState); Y.applyUpdate(scratch, prepared.update);
    const after = { ...state, yjsState: Y.encodeStateAsUpdate(scratch), stateVector: Y.encodeStateVector(scratch) };
    if (physicalNativeV2Serialize(after) !== expected) return physicalNativeV2Fail('UNSUPPORTED');
    const inverse = prepareNativeLinkInverseV4({ state: after, inverseRecipes: prepared.inverseRecipes, operationId: `${operationId}:inverse` });
    Y.applyUpdate(scratch, inverse.update);
    if (physicalNativeV2Serialize({ ...state, yjsState: Y.encodeStateAsUpdate(scratch), stateVector: Y.encodeStateVector(scratch) }) !== source) return physicalNativeV2Fail('UNSUPPORTED');
    // Scratch insertion clocks are intentionally absent from the durable proof.
    // They are verified transiently; identical genuine inputs yield identical bindings.
    const batchProof = proof({ sourceStateProof: inventory.version.stateProof, sourceProof,
      expectedSerializedHash: createHash('sha256').update(expected).digest('hex') });
    return physical.map((link, index) => proof({ batchProof, physicalLinkId: link.physicalLinkId,
      nativeLinkId: native[index].id, reference: native[index].ref, probe: probes[index] }));
  } finally { scratch.destroy(); }
}


function physicalNativeV2AssertCoverage(coverage: NativeDocumentLinkInventoryV4['coverage'] | PhysicalMarkdownSourceEvidenceV5['coverage']): void {
  if (coverage.complete !== (coverage.gaps.length === 0) || coverage.gaps.length > MAX_LINKS) return physicalNativeV2Fail('CHANGED');
  for (const gap of coverage.gaps) {
    if (gap.code !== 'uninspected-html') return physicalNativeV2Fail('UNSUPPORTED');
    if ('raw' in gap && (typeof gap.raw !== 'string' || !inspectWorkspaceStaticHtmlLinks(gap.raw).fullyInspected)) return physicalNativeV2Fail('UNSUPPORTED');
  }
}
function physicalNativeV2HtmlFacts(input: WorkspaceMarkdownHtmlInspectionV4, sourcePath: string,
  maximumPosition: number): WorkspaceMarkdownHtmlInspectionV4 {
  const result = physicalNativeV2Capture(input) as WorkspaceMarkdownHtmlInspectionV4;
  physicalNativeV2Object(result, ['parserVersion', 'occurrences']);
  if (result.parserVersion !== 4 || !Array.isArray(result.occurrences) || result.occurrences.length > MAX_LINKS) return physicalNativeV2Fail();
  let previous = 0, targets = 0;
  for (const row of result.occurrences) {
    physicalNativeV2Object(row, ['sourcePath', 'start', 'end', 'raw', 'fullyInspected', 'explicitLocalTargets']);
    if (row.sourcePath !== sourcePath || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end)
      || row.start < previous || row.end <= row.start || row.end > maximumPosition || typeof row.raw !== 'string'
      || row.raw.length !== row.end - row.start || row.fullyInspected !== true || !Array.isArray(row.explicitLocalTargets)
      || !equal(inspectWorkspaceStaticHtmlLinks(row.raw), { inspectionVersion: 1, fullyInspected: true, explicitLocalTargets: row.explicitLocalTargets })) return physicalNativeV2Fail('UNSUPPORTED');
    targets += row.explicitLocalTargets.length; if (targets > MAX_LINKS) return physicalNativeV2Fail('UNSUPPORTED'); previous = row.end;
  }
  return result;
}

/** Strict historical data decoder. Hashes and declared receipt/namespace facts
 * do not certify actual persistence, current state or an unaffected operation. */
export function decodePhysicalNativeImportBindingV2(input: unknown): PhysicalNativeImportBindingV2 {
  try {
    const value = physicalNativeV2Capture(input) as PhysicalNativeImportBindingV2;
    physicalNativeV2Object(value, ['version', 'original4', 'source', 'receipt', 'nativeInventory', 'nativeBinaryHash', 'nativeVectorHash', 'html', 'links', 'bindingProof']);
    if (value.version !== 2) return physicalNativeV2Fail();
    const original = decodePhysicalMarkdownSourceEvidenceV5(value.original4), inventory = decodeNativeInventoryV4Facts(value.nativeInventory);
    physicalNativeV2AssertCoverage(original.coverage); physicalNativeV2AssertCoverage(inventory.coverage);
    const source = physicalNativeV2Object(value.source, ['parserVersion', 'workspaceId', 'organizationId', 'path', 'physicalSourceProof', 'filesystemIdentity', 'sourceHash', 'sourceBytes']);
    if (!equal(source, { parserVersion: 4, workspaceId: original.workspaceId, organizationId: original.organizationId, path: original.path,
      physicalSourceProof: original.physicalSourceProof, filesystemIdentity: original.physical.filesystemIdentity,
      sourceHash: original.physical.byteHash, sourceBytes: original.physical.byteLength })) return physicalNativeV2Fail('CHANGED');
    const rawReceipt = physicalNativeV2Object(value.receipt, ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired']);
    const target = physicalNativeV2Object(rawReceipt.target, targetKeys);
    const inertIdentity = { ...inventory.document, documentSequence: inventory.version.documentSequence, persistedAt: inventory.version.persistedAt,
      newlineStyle: target.newlineStyle, hasBom: target.hasBom } as PersistedCollaborationState;
    const receipt = physicalNativeV2ReceiptIdentity(value.receipt, inertIdentity, target.lineageId);
    if (receipt.sourceHash !== original.physical.byteHash || receipt.sourceBytes !== original.physical.byteLength
      || inventory.version.stateProof !== receipt.target.initialStateProof || inventory.version.documentSequence !== 0
      || inventory.version.persistedAt !== receipt.target.persistedAt || inventory.document.lifecycleGeneration !== 1
      || receipt.target.hasBom !== original.hasBom || ['mixed', 'bare-cr'].includes(original.lineEndings.style)
      || receipt.target.newlineStyle !== (original.lineEndings.style === 'crlf' ? 'crlf' : 'lf')
      || typeof value.nativeBinaryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.nativeBinaryHash)
      || typeof value.nativeVectorHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.nativeVectorHash)
      || createHash('sha256').update(Buffer.from(inventory.version.stateVector, 'base64')).digest('hex') !== value.nativeVectorHash) return physicalNativeV2Fail('CHANGED');
    const sameTarget = inventory.document.workspaceId === original.workspaceId && inventory.document.path === original.path;
    if (inventory.document.workspaceId === original.workspaceId && inventory.document.organizationId !== original.organizationId
      || original.authority.kind === 'registered-never-initialized'
        && (sameTarget ? inventory.document.documentId !== original.authority.registeredDocumentId : inventory.document.documentId === original.authority.registeredDocumentId)
      || original.authority.kind === 'registered-never-initialized' && original.authority.lineageId !== null
        && (sameTarget ? receipt.target.lineageId !== original.authority.lineageId : receipt.target.lineageId === original.authority.lineageId)) return physicalNativeV2Fail('CHANGED');
    const expectedMetadata = { ...original.metadata, path: inventory.document.path,
      title: original.metadata.hasExplicitTitle || original.metadata.headings.length ? original.metadata.title
        : path.posix.basename(inventory.document.path).replace(/\.(?:md|markdown)$/iu, '') };
    if (!equal(inventory.metadata, expectedMetadata)) return physicalNativeV2Fail('CHANGED');
    physicalNativeV2Object(value.html, ['version', 'original', 'imported', 'originalSourceProof', 'nativeSourceProof']);
    const originalHtml = physicalNativeV2HtmlFacts(value.html.original, original.path, original.physical.byteLength);
    const importedHtml = physicalNativeV2HtmlFacts(value.html.imported, inventory.document.path, original.physical.byteLength);
    const normalized = (html: WorkspaceMarkdownHtmlInspectionV4) => html.occurrences.map(row => ({
      raw: row.raw.replace(/\r\n/gu, '\n'), fullyInspected: row.fullyInspected, explicitLocalTargets: row.explicitLocalTargets }));
    const facts = (html: WorkspaceMarkdownHtmlInspectionV4) => ({ parserVersion: 4, occurrences: html.occurrences.map(row => ({
      raw: row.raw, fullyInspected: row.fullyInspected, explicitLocalTargets: row.explicitLocalTargets })) });
    if (value.html.version !== 1 || !equal(originalHtml, original.htmlInspection) || !equal(normalized(originalHtml), normalized(importedHtml))
      || value.html.originalSourceProof !== proof(facts(originalHtml)) || value.html.nativeSourceProof !== proof(facts(importedHtml))) return physicalNativeV2Fail('CHANGED');
    // Truthful legacy source gaps remain exact even though every HTML node
    // has been inspected. Inspectability is not global Markdown completeness.
    const physicalGaps = originalHtml.occurrences.filter(row => row.explicitLocalTargets.length).map(row => ({
      code: 'uninspected-html', path: original.path, startUtf16: row.start, htmlTargets: row.explicitLocalTargets }));
    const nativeGaps = importedHtml.occurrences.filter(row => row.explicitLocalTargets.length).map(row => ({
      code: 'uninspected-html', path: inventory.document.path, raw: row.raw, htmlTargets: row.explicitLocalTargets }));
    if (!equal(original.coverage, { complete: physicalGaps.length === 0, gaps: physicalGaps })
      || !equal(inventory.coverage, { complete: nativeGaps.length === 0, gaps: nativeGaps })) return physicalNativeV2Fail('CHANGED');
    const native = inventory.links.filter(link => link.classification === 'local' || link.classification === 'anchor-only' && link.kind === 'wiki');
    if (!Array.isArray(value.links) || value.links.length !== original.links.length || native.length !== original.links.length) return physicalNativeV2Fail('CHANGED');
    const physicalIds = new Set<string>(), nativeIds = new Set<string>();
    for (const [index, link] of value.links.entries()) {
      physicalNativeV2Object(link, ['physicalLinkId', 'nativeLinkId', 'reference', 'occurrenceProof']);
      if (link.physicalLinkId !== original.links[index].physicalLinkId || link.nativeLinkId !== native[index].id
        || !equal(link.reference, native[index].ref) || !equal(physicalNativeV2LinkMeaning(original.links[index]), physicalNativeV2LinkMeaning(native[index]))
        || typeof link.occurrenceProof !== 'string' || !/^[a-f0-9]{64}$/u.test(link.occurrenceProof) || physicalIds.has(link.physicalLinkId) || nativeIds.has(link.nativeLinkId)) return physicalNativeV2Fail('CHANGED');
      physicalIds.add(link.physicalLinkId); nativeIds.add(link.nativeLinkId);
    }
    const { bindingProof, ...body } = value;
    if (typeof bindingProof !== 'string' || !/^[a-f0-9]{64}$/u.test(bindingProof) || proof(body) !== bindingProof) return physicalNativeV2Fail('CHANGED');
    return physicalNativeV2Freeze(value);
  } catch (error) { if (error instanceof PhysicalNativeImportBindingV2Error) throw error; return physicalNativeV2Fail('UNSUPPORTED'); }
}

/** Actual Physical4 bytes -> actual imported Native4 state plus exact
 * serialization and ordinary forward/inverse probes. There is no HTML rewrite,
 * E5 namespace assessment, FD capability, SQL, principal, birth insertion or grant. */
export function bindPhysicalNativeImportLinksV2(input: PhysicalNativeImportBindingInputV2): PhysicalNativeImportBindingV2 {
  try {
    const values = physicalNativeV2Object(input, ['original', 'receipt', 'state', 'lineageId']);
    const originalFields = physicalNativeV2Object(values.original, physicalKeys);
    const originalBytes = physicalNativeV2Binary(originalFields.originalBytes, MAX_INDEXED_MARKDOWN_BYTES); delete originalFields.originalBytes;
    const supplied = decodePhysicalMarkdownSourceEvidenceV5(originalFields);
    const original = inspectOriginalPhysicalLinksV4({ workspaceId: supplied.workspaceId, organizationId: supplied.organizationId,
      path: supplied.path, authority: supplied.authority, bytes: originalBytes, filesystemIdentity: supplied.physical.filesystemIdentity, maxLinks: MAX_LINKS });
    const { originalBytes: _bytes, ...original4 } = original;
    if (!equal(original4, supplied)) return physicalNativeV2Fail('CHANGED');
    physicalNativeV2AssertCoverage(original.coverage);
    physicalNativeV2HtmlFacts(original.htmlInspection, original.path, originalBytes.byteLength);
    const rawState = physicalNativeV2Object(values.state, stateKeys, ['projectionError', 'projectionFinalized']);
    const yjsState = physicalNativeV2Binary(rawState.yjsState, MAX_STATE_BYTES), stateVector = physicalNativeV2Binary(rawState.stateVector, MAX_VECTOR_BYTES);
    delete rawState.yjsState; delete rawState.stateVector;
    const state = { ...physicalNativeV2Capture(rawState) as Omit<PersistedCollaborationState, 'yjsState' | 'stateVector'>, yjsState, stateVector };
    if (state.status !== 'active' || state.degraded || state.projectionError || !isCanonicalAdmissionPath(state.path)
      || !/\.(?:md|markdown)$/iu.test(state.path) || state.schemaVersion !== 1
      || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(state.representation)
      || !['lf', 'crlf'].includes(state.newlineStyle) || typeof state.hasBom !== 'boolean') return physicalNativeV2Fail('CHANGED');
    const receipt = physicalNativeV2ReceiptIdentity(values.receipt, state, values.lineageId);
    const source = Buffer.from(originalBytes).toString('utf8');
    const prepared = prepareMarkdownFileImport(originalBytes, { representation: state.representation });
    if (physicalNativeV2Serialize(state) !== source || prepared.sourceHash !== original.physical.byteHash
      || prepared.sourceBytes !== original.physical.byteLength) return physicalNativeV2Fail('CHANGED');
    const inventory = inspectPersistedDocumentLinksV4(state); physicalNativeV2AssertCoverage(inventory.coverage);
    const targetPhysical = inspectOriginalPhysicalLinksV4({ workspaceId: state.workspaceId, organizationId: state.organizationId,
      path: state.path, authority: original.authority, bytes: originalBytes, filesystemIdentity: original.physical.filesystemIdentity, maxLinks: MAX_LINKS });
    if (!equal(targetPhysical.metadata, inventory.metadata)) return physicalNativeV2Fail('CHANGED');
    const native = inventory.links.filter(link => link.classification === 'local' || link.classification === 'anchor-only' && link.kind === 'wiki');
    const pairChecks = original.links.length * inventory.links.length;
    const workBytes = (2 * original.links.length + 8) * (originalBytes.byteLength + yjsState.byteLength + stateVector.byteLength) + 64 * pairChecks;
    if (pairChecks > MAX_LINK_PAIR_CHECKS || workBytes > MAX_WORK_BYTES || native.length !== original.links.length) return physicalNativeV2Fail('UNSUPPORTED');
    for (const [index, link] of original.links.entries()) if (!equal(physicalNativeV2LinkMeaning(link), physicalNativeV2LinkMeaning(native[index]))) return physicalNativeV2Fail('CHANGED');
    const occurrences = physicalNativeV2Rehearse(state, inventory, native, original.links, source, prepared.canonical, original.physicalSourceProof);
    const imported = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => inspectWorkspaceMarkdownHtmlV4(
      snapshot.content.kind === 'plain_text' ? snapshot.content.text : richMarkdownFromYDoc(doc), state.path));
    const htmlProof = (html: WorkspaceMarkdownHtmlInspectionV4) => proof({ parserVersion: 4, occurrences: html.occurrences.map(row => ({
      raw: row.raw, fullyInspected: row.fullyInspected, explicitLocalTargets: row.explicitLocalTargets })) });
    const body = { version: 2 as const, original4, source: { parserVersion: 4 as const, workspaceId: original.workspaceId,
      organizationId: original.organizationId, path: original.path, physicalSourceProof: original.physicalSourceProof,
      filesystemIdentity: original.physical.filesystemIdentity, sourceHash: original.physical.byteHash, sourceBytes: original.physical.byteLength },
      receipt, nativeInventory: inventory, nativeBinaryHash: createHash('sha256').update(yjsState).digest('hex'),
      nativeVectorHash: createHash('sha256').update(stateVector).digest('hex'), html: { version: 1 as const,
        original: original.htmlInspection, imported, originalSourceProof: htmlProof(original.htmlInspection), nativeSourceProof: htmlProof(imported) },
      links: original.links.map((link, index) => ({ physicalLinkId: link.physicalLinkId, nativeLinkId: native[index].id,
        reference: native[index].ref, occurrenceProof: occurrences[index] })) };
    return decodePhysicalNativeImportBindingV2({ ...body, bindingProof: proof(body) });
  } catch (error) { if (error instanceof PhysicalNativeImportBindingV2Error) throw error; return physicalNativeV2Fail('UNSUPPORTED'); }
}
