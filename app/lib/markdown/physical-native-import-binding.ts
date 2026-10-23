import 'server-only';

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
import { isNativeSourceFilesystemFingerprint } from '../files/workspace-operation-native-source-evidence';
import type { NativeDocumentLink, NativeDocumentLinkInventory } from './workspace-link-contract-v2';
import { inspectPersistedDocumentLinksV3, nativeLinkJsonProof as proof,
  type NativeDocumentLinkInventoryV3 } from './workspace-native-link-inventory';
import { prepareNativeLinkInverse, prepareNativeLinkMutations } from './workspace-native-link-mutations';
import { inspectOriginalPhysicalLinks, inspectOriginalPhysicalLinksV3, type OriginalPhysicalLink, type OriginalPhysicalLinkInventory } from './workspace-physical-link-inventory';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';

export type PhysicalNativeImportBindingInput = Readonly<{
  original: OriginalPhysicalLinkInventory;
  receipt: MarkdownFileImportReceipt;
  state: PersistedCollaborationState;
  /** Observed lineage fact; this pure function cannot authenticate its caller. */
  lineageId: string;
}>;
export type PhysicalNativeImportBindingV1 = Readonly<{
  version: 1;
  source: Readonly<{ workspaceId: string; organizationId: string | null; path: string;
    physicalSourceProof: string; filesystemIdentity: string; sourceHash: string; sourceBytes: number }>;
  receipt: MarkdownFileImportReceipt;
  nativeInventory: NativeDocumentLinkInventoryV3;
  nativeBinaryHash: string;
  nativeVectorHash: string;
  /** References are taken only from the actual target inventory, never from offsets. */
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
  'applicability', 'executionReady', 'physicalSourceProof'] as const;
const stateKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'lifecycleGeneration', 'schemaVersion',
  'yjsState', 'stateVector', 'documentSequence', 'persistedAt', 'checkpointedAt', 'checkpointSequence', 'canonicalHash',
  'serializedHash', 'newlineStyle', 'hasBom', 'degraded', 'status', 'projectionError', 'projectionFinalized'] as const;
const targetKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration',
  'newlineStyle', 'hasBom', 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;

export class PhysicalNativeImportBindingError extends Error {
  readonly status = 409;
  constructor(readonly code: 'INVALID' | 'CHANGED' | 'UNSUPPORTED') {
    super(`Physical to native import binding is unavailable: ${code}.`);
    this.name = 'PhysicalNativeImportBindingError';
  }
}
function reject(code: PhysicalNativeImportBindingError['code'] = 'INVALID'): never {
  throw new PhysicalNativeImportBindingError(code);
}
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => reject(reason === 'too-large' ? 'UNSUPPORTED' : 'INVALID'), 16 * 1024 * 1024);
}
/** Inspect descriptors before reading input values; getters/Proxies never run. */
function object(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return reject();
  const names = Reflect.ownKeys(input);
  if (names.length > keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return reject();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor && optional.includes(key)) continue;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
    result[key] = descriptor.value;
  }
  return result;
}
function binary(input: unknown, maximum: number): Uint8Array {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !ArrayBuffer.isView(input)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
    || ['buffer', 'byteLength', 'byteOffset', 'constructor'].some(key => Object.hasOwn(input, key))) return reject();
  const length = intrinsicByteLength.call(input) as number;
  if (!Number.isSafeInteger(length) || length > maximum) return reject('UNSUPPORTED');
  if (Object.getPrototypeOf(intrinsicBuffer.call(input)) !== ArrayBuffer.prototype) return reject();
  const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, input as Uint8Array); return bytes;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function receiptIdentity(input: unknown, state: PersistedCollaborationState, lineageId: unknown): MarkdownFileImportReceipt {
  const receipt = object(capture(input), ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired']);
  const target = object(receipt.target, targetKeys);
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
    || typeof target.initialStateProof !== 'string' || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(target.initialStateProof)) return reject('CHANGED');
  return receipt as MarkdownFileImportReceipt;
}
function serializeImportedState(state: PersistedCollaborationState): string {
  return inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => serializeCanonicalText(
    snapshot.content.kind === 'plain_text' ? snapshot.content.text : richMarkdownFromYDoc(doc), state));
}
/** A physical UTF16 boundary is evidence only, never a Yjs relative position. */
function canonicalPhysicalOffset(source: string, offsets: readonly number[]): Map<number, number> {
  const result = new Map<number, number>(); let previous = 0, canonical = 0;
  for (const offset of [...new Set(offsets)].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length
      || /[\uD800-\uDBFF]/u.test(source.charAt(offset - 1)) && /[\uDC00-\uDFFF]/u.test(source.charAt(offset))
      || source.charAt(offset - 1) === '\r' && source.charAt(offset) === '\n') return reject();
    let part = source.slice(previous, offset);
    if (previous === 0 && part.startsWith('\uFEFF')) part = part.slice(1);
    canonical += part.replace(/\r\n/gu, '\n').length;
    result.set(offset, canonical); previous = offset;
  }
  return result;
}
function linkMeaning(link: OriginalPhysicalLink | NativeDocumentLink): unknown {
  return { kind: link.kind, syntax: link.syntax, literal: 'targetLiteral' in link ? link.targetLiteral : link.literal,
    targetPathText: link.targetPathText, fragment: link.fragment, alias: link.alias, embed: link.embed };
}
function probeTarget(link: NativeDocumentLink, probe: string): string {
  if (link.ref.kind !== 'node-attribute' || link.ref.attribute !== 'target') return probe;
  if (!link.ref.expected.startsWith(link.literal) || link.ref.expected.slice(link.literal.length)
    && !link.ref.expected.slice(link.literal.length).startsWith('|')) return reject('UNSUPPORTED');
  return probe + link.ref.expected.slice(link.literal.length);
}
/** A single batch uses unique probes at disjoint physical ranges. Exact whole
 * forward/inverse bytes certify each ordered candidate, including duplicates;
 * no alternative candidate search or repeated whole-document serialization. */
function rehearseLink(state: PersistedCollaborationState, inventory: Pick<NativeDocumentLinkInventory, 'document' | 'version'>, native: readonly NativeDocumentLink[],
  physical: readonly OriginalPhysicalLink[], source: string, canonical: string, sourceProof: string): string[] {
  if (!physical.length) return [];
  const prefix = `canvas-import-proof-${sourceProof.slice(0, 32)}-`;
  if (source.includes(prefix)) return reject('UNSUPPORTED');
  const offsets = canonicalPhysicalOffset(source, physical.flatMap(link => [link.targetRange.startUtf16, link.targetRange.endUtf16]));
  const parts: string[] = [], probes: string[] = []; let position = 0;
  for (const [index, link] of physical.entries()) {
    const start = offsets.get(link.targetRange.startUtf16)!, end = offsets.get(link.targetRange.endUtf16)!;
    if (start < position || end <= start || canonical.slice(start, end) !== link.targetLiteral) return reject('CHANGED');
    const probe = `${prefix}${index}.md`;
    parts.push(canonical.slice(position, start), probe); probes.push(probe); position = end;
  }
  parts.push(canonical.slice(position));
  const expected = serializeCanonicalText(parts.join(''), state);
  const operationId = 'physical-native-import-proof:batch';
  const prepared = prepareNativeLinkMutations({ state, operationId, recipes: native.map((link, index) => ({
    linkId: link.id, source: inventory.document, sourceVersion: inventory.version, reference: link.ref,
    destinationWorkspaceId: state.workspaceId, sourcePathAfter: state.path,
    cloneSelection: null, action: 'rewrite' as const, nextValue: probeTarget(link, probes[index]),
    expectedTargetIdentity: probes[index] })) });
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, state.yjsState); Y.applyUpdate(scratch, prepared.update);
    const after = { ...state, yjsState: Y.encodeStateAsUpdate(scratch), stateVector: Y.encodeStateVector(scratch) };
    if (serializeImportedState(after) !== expected) return reject('UNSUPPORTED');
    const inverse = prepareNativeLinkInverse({ state: after, inverseRecipes: prepared.inverseRecipes, operationId: `${operationId}:inverse` });
    Y.applyUpdate(scratch, inverse.update);
    if (serializeImportedState({ ...state, yjsState: Y.encodeStateAsUpdate(scratch), stateVector: Y.encodeStateVector(scratch) }) !== source) return reject('UNSUPPORTED');
    // Scratch insertion clocks are intentionally absent from the durable proof.
    // They are verified transiently; identical genuine inputs yield identical bindings.
    const batchProof = proof({ sourceStateProof: inventory.version.stateProof, sourceProof,
      expectedSerializedHash: createHash('sha256').update(expected).digest('hex') });
    return physical.map((link, index) => proof({ batchProof, physicalLinkId: link.physicalLinkId,
      nativeLinkId: native[index].id, reference: native[index].ref, probe: probes[index] }));
  } finally { scratch.destroy(); }
}

/** Pure evidence derivation: no current authorization, registry lookup, import,
 * persistence or filesystem action. ReceiptV1 has no historical FD version:
 * the caller must additionally bind this exact source proof/FD to its actual
 * held SourceCapture/CopyOriginal or OriginalImportRecord. This helper proves
 * bytes, inventories and actual native references, never FD-to-receipt authority. */
export function bindPhysicalNativeImportLinks(input: PhysicalNativeImportBindingInput): PhysicalNativeImportBindingV1 {
  try {
    const values = object(input, ['original', 'receipt', 'state', 'lineageId']);
    const physical = object(values.original, physicalKeys);
    if (types.isProxy(physical.links) || !Array.isArray(physical.links) || physical.links.length > MAX_LINKS) return reject('UNSUPPORTED');
    const originalBytes = binary(physical.originalBytes, MAX_INDEXED_MARKDOWN_BYTES); delete physical.originalBytes;
    const originalFacts = capture(physical) as Omit<OriginalPhysicalLinkInventory, 'originalBytes'>;
    const authority = object(originalFacts.authority, originalFacts.authority?.kind === 'unregistered'
      ? ['kind', 'catalogueProof'] : ['kind', 'catalogueProof', 'registeredDocumentId', 'lineageId']);
    if (!['unregistered', 'registered-never-initialized'].includes(authority.kind as string)
      || typeof authority.catalogueProof !== 'string' || !/^[a-f0-9]{64}$/u.test(authority.catalogueProof)
      || authority.kind === 'registered-never-initialized' && [authority.registeredDocumentId, authority.lineageId]
        .some((value, index) => value !== null || index === 0 ? typeof value !== 'string' || !value || value.length > 256
          || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) : false)
      || typeof originalFacts.workspaceId !== 'string' || !originalFacts.workspaceId || originalFacts.workspaceId.length > 256
      || originalFacts.workspaceId.trim() !== originalFacts.workspaceId || /[\u0000-\u001f\u007f]/u.test(originalFacts.workspaceId)
      || originalFacts.organizationId !== null && (typeof originalFacts.organizationId !== 'string' || !originalFacts.organizationId
        || originalFacts.organizationId.length > 256 || originalFacts.organizationId.trim() !== originalFacts.organizationId
        || /[\u0000-\u001f\u007f]/u.test(originalFacts.organizationId))
      || !isCanonicalAdmissionPath(originalFacts.path) || !/\.(?:md|markdown)$/iu.test(originalFacts.path)
      || !isNativeSourceFilesystemFingerprint(originalFacts.physical.filesystemIdentity)
      || Number(originalFacts.physical.filesystemIdentity.split(':')[2]) !== originalBytes.byteLength) return reject();
    if (originalFacts.parserVersion !== 2 && originalFacts.parserVersion !== 3) return reject();
    const inspectPhysical = originalFacts.parserVersion === 3 ? inspectOriginalPhysicalLinksV3 : inspectOriginalPhysicalLinks;
    const original = inspectPhysical({ workspaceId: originalFacts.workspaceId, organizationId: originalFacts.organizationId,
      path: originalFacts.path, authority: originalFacts.authority, bytes: originalBytes,
      filesystemIdentity: originalFacts.physical.filesystemIdentity, maxLinks: MAX_LINKS });
    const { originalBytes: _private, ...reparsedFacts } = original;
    if (!equal(originalFacts, reparsedFacts) || !original.coverage.complete || original.coverage.gaps.length) return reject('CHANGED');
    const rawState = object(values.state, stateKeys, ['projectionError', 'projectionFinalized']);
    const yjsState = binary(rawState.yjsState, MAX_STATE_BYTES), stateVector = binary(rawState.stateVector, MAX_VECTOR_BYTES);
    delete rawState.yjsState; delete rawState.stateVector;
    const state = { ...capture(rawState) as Omit<PersistedCollaborationState, 'yjsState' | 'stateVector'>, yjsState, stateVector };
    if (state.status !== 'active' || state.degraded || state.projectionError || !isCanonicalAdmissionPath(state.path)
      || !/\.(?:md|markdown)$/iu.test(state.path) || state.schemaVersion !== 1
      || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(state.representation)
      || !['lf', 'crlf'].includes(state.newlineStyle) || typeof state.hasBom !== 'boolean') return reject('CHANGED');
    const receipt = receiptIdentity(values.receipt, state, values.lineageId);
    if (receipt.sourceHash !== original.physical.byteHash || receipt.sourceBytes !== original.physical.byteLength
      || receipt.target.hasBom !== original.hasBom || original.lineEndings.style === 'mixed' || original.lineEndings.style === 'bare-cr'
      || receipt.target.newlineStyle !== (original.lineEndings.style === 'crlf' ? 'crlf' : 'lf')) return reject('CHANGED');
    const sameTarget = state.workspaceId === original.workspaceId && state.path === original.path;
    if (state.workspaceId === original.workspaceId && state.organizationId !== original.organizationId) return reject('CHANGED');
    if (original.authority.kind === 'registered-never-initialized'
      && (sameTarget ? state.documentId !== original.authority.registeredDocumentId
        : state.documentId === original.authority.registeredDocumentId)) return reject('CHANGED');
    if (original.authority.kind === 'registered-never-initialized' && original.authority.lineageId !== null
      && (sameTarget ? receipt.target.lineageId !== original.authority.lineageId
        : receipt.target.lineageId === original.authority.lineageId)) return reject('CHANGED');
    const linkPairChecks = original.links.length * original.links.length;
    // Batch serialization is constant-count, but the shared mutation adapter
    // still validates native ownership/projection per recipe, in both directions.
    const workBytes = (2 * original.links.length + 8) * (originalBytes.byteLength + yjsState.byteLength + stateVector.byteLength) + 64 * linkPairChecks;
    if (linkPairChecks > MAX_LINK_PAIR_CHECKS || workBytes > MAX_WORK_BYTES) return reject('UNSUPPORTED');
    const prepared = prepareMarkdownFileImport(originalBytes, { representation: state.representation });
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
    if (prepared.sourceHash !== receipt.sourceHash || prepared.sourceBytes !== receipt.sourceBytes
      || prepared.hasBom !== state.hasBom || prepared.newlineStyle !== state.newlineStyle
      || serializeCanonicalText(prepared.canonical, state) !== source || serializeImportedState(state) !== source) return reject('CHANGED');
    const inventory = inspectPersistedDocumentLinksV3(state);
    if (!inventory.coverage.complete || inventory.coverage.gaps.length || inventory.parserVersion !== 3
      || inventory.version.stateProof !== receipt.target.initialStateProof || inventory.version.documentSequence !== 0
      || inventory.version.persistedAt !== receipt.target.persistedAt) return reject('CHANGED');
    const targetPhysical = inspectPhysical({ workspaceId: state.workspaceId, organizationId: state.organizationId,
      path: state.path, authority: original.authority, bytes: originalBytes, filesystemIdentity: original.physical.filesystemIdentity, maxLinks: MAX_LINKS });
    if (!targetPhysical.coverage.complete || !equal(targetPhysical.metadata, inventory.metadata)) return reject('UNSUPPORTED');
    // The physical parser includes self-heading/block Wiki targets. Its
    // Markdown URL parser excludes anchor-only inline URLs; retain that exact
    // cohort instead of assuming the two native classifications are identical.
    const nativeLinks = inventory.links.filter(link => link.classification === 'local'
      || link.classification === 'anchor-only' && link.kind === 'wiki');
    const actualPairChecks = original.links.length * inventory.links.length;
    if (actualPairChecks > MAX_LINK_PAIR_CHECKS || workBytes + 64 * (actualPairChecks - linkPairChecks) > MAX_WORK_BYTES) return reject('UNSUPPORTED');
    if (nativeLinks.length !== original.links.length || new Set(inventory.links.map(link => link.id)).size !== inventory.links.length
      || new Set(original.links.map(link => link.physicalLinkId)).size !== original.links.length) return reject('UNSUPPORTED');
    for (const [index, link] of original.links.entries()) if (!equal(linkMeaning(link), linkMeaning(nativeLinks[index]))) return reject('UNSUPPORTED');
    const occurrenceProofs = rehearseLink(state, inventory, nativeLinks, original.links, source, prepared.canonical, original.physicalSourceProof);
    const links = original.links.map((link, index) => {
      const native = nativeLinks[index];
      return { physicalLinkId: link.physicalLinkId, nativeLinkId: native.id, reference: native.ref, occurrenceProof: occurrenceProofs[index] };
    });
    const body = { version: 1 as const, source: { workspaceId: original.workspaceId, organizationId: original.organizationId,
      path: original.path, physicalSourceProof: original.physicalSourceProof, filesystemIdentity: original.physical.filesystemIdentity,
      sourceHash: original.physical.byteHash, sourceBytes: original.physical.byteLength }, receipt, nativeInventory: inventory,
    nativeBinaryHash: createHash('sha256').update(yjsState).digest('hex'), nativeVectorHash: createHash('sha256').update(stateVector).digest('hex'), links };
    const detached = capture(body) as typeof body;
    return freeze({ ...detached, bindingProof: proof(detached) });
  } catch (error) {
    if (error instanceof PhysicalNativeImportBindingError) throw error;
    return reject('UNSUPPORTED');
  }
}
