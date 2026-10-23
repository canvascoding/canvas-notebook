import 'server-only';

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { assertNativeDocumentSchema } from '../collaboration/native-document-schema';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { isCollaborationStateProof } from '../collaboration/state-proof';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import type { NativeDocumentLinkInventory, NativeDocumentLink } from '../markdown/workspace-link-contract-v2';
import { inspectNativeDocumentLinks, nativeLinkJsonProof, type NativeDocumentLinkInventoryV4 } from '../markdown/workspace-native-link-inventory';
import { evaluateWorkspaceHtmlLinks, inspectWorkspaceStaticHtmlLinks } from '../markdown/workspace-html-link-safety';
import { inspectWorkspaceMarkdownHtmlV4 } from '../markdown/workspace-local-link-parser';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_VECTOR_BYTES = 1024 * 1024;
const MAX_PRIVATE_BYTES = 32 * 1024 * 1024;
const MAX_PATHS = 10_000;
const MAX_LINKS = 20_000;
type NativeStage = Omit<WorkspaceSourceAuthorityStage, 'sources'> & {
  sources: Array<Extract<WorkspaceSourceAuthorityStage['sources'][number], { kind: 'native' }>>;
};
export type WorkspaceOperationNativeSourceEvidenceV1 = Readonly<{
  evidenceVersion: 1;
  workspaceScope: WorkspaceOperationJobScope;
  stage: NativeStage;
  nativeBindings: readonly WorkspaceNativeSourceBinding[];
  /** Excludes replaceable native projections and directory entry timestamps. */
  semanticProof: string;
  evidenceProof: string;
}>;
export type WorkspaceOperationNativeSourceEvidenceV2 = Readonly<Omit<WorkspaceOperationNativeSourceEvidenceV1, 'evidenceVersion'> & {
  evidenceVersion: 2;
  semanticCatalogueProof: string;
}>;
export type WorkspaceOperationNativeSourceEvidence = WorkspaceOperationNativeSourceEvidenceV1 | WorkspaceOperationNativeSourceEvidenceV2;
/** Separate facts-only component for the HTML-aware operation arm. Historical
 * V1/V2 decoders never accept this discriminant. Coverage gaps remain intact;
 * neither these facts nor a successful decode grant execution authority. */
export type WorkspaceOperationNativeHtmlSourceEvidenceV4 = Readonly<Omit<WorkspaceOperationNativeSourceEvidenceV2, 'evidenceVersion'> & {
  evidenceVersion: 4;
  htmlSources: readonly Readonly<{ documentId: string; path: string; inventoryProof: string;
    inspection: ReturnType<typeof inspectWorkspaceMarkdownHtmlV4> }>[];
}>;
type NativeEvidenceFacts = WorkspaceOperationNativeSourceEvidence | WorkspaceOperationNativeHtmlSourceEvidenceV4;
export class WorkspaceOperationNativeSourceEvidenceError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_SOURCE_EVIDENCE_INVALID' | 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE'
    | 'NATIVE_SOURCE_IMPORT_REQUIRED' | 'NATIVE_SOURCE_EVIDENCE_CHANGED') {
    super(code); this.name = 'WorkspaceOperationNativeSourceEvidenceError';
  }
}
function fail(code: WorkspaceOperationNativeSourceEvidenceError['code'] = 'NATIVE_SOURCE_EVIDENCE_INVALID'): never {
  throw new WorkspaceOperationNativeSourceEvidenceError(code);
}
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
const text = (value: unknown, maximum = 65_536): value is string => typeof value === 'string' && value.length <= maximum;
const id = (value: unknown): value is string => text(value, 256) && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
const nullableId = (value: unknown): boolean => value === null || id(value);
const canonicalPath = (value: unknown): value is string => text(value, 4096) && isCanonicalAdmissionPath(value)
  && value.split('/').length <= 33;
const representations = ['plain_text', 'tiptap_xml', 'tiptap_blocks'];
type RecordValue = Record<string, unknown>;

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): RecordValue {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length || required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) fail();
  const captured: RecordValue = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    captured[key as string] = descriptor.value;
  }
  return captured;
}
function list(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!integer(length) || length > maximum || Reflect.ownKeys(value).length !== length + 1) fail();
  const copied: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    copied.push(descriptor.value);
  }
  return copied;
}
function jsonStringBytes(value: string): number {
  let length = Buffer.byteLength(value, 'utf8') + 2;
  if (length > MAX_EVIDENCE_BYTES) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  for (const match of value.matchAll(/["\\\u0000-\u001f]/gu)) {
    length += /["\\\b\f\n\r\t]/u.test(match[0]) ? 1 : 5;
    if (length > MAX_EVIDENCE_BYTES) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  }
  return length;
}
type JsonBudget = { remaining: number; nodes: number };

/** Bounded data capture only; getters, typed binary state and custom objects
 * never become a persisted plan. This function grants no read/write authority. */
function plainJson(value: unknown, budget: JsonBudget = { remaining: MAX_EVIDENCE_BYTES, nodes: 200_000 }): unknown {
  const ancestors = new Set<object>();
  const charge = (amount: number) => {
    budget.remaining -= amount; if (budget.remaining < 0) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (--budget.nodes < 0 || depth > 32) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    if (item === null || typeof item === 'boolean') { charge(item === null || item === true ? 4 : 5); return item; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) fail(); charge(String(item).length); return item;
    }
    if (typeof item === 'string') {
      // Count escapes before cloning/stringifying; reject invalid Unicode rather
      // than silently hashing its UTF-8 replacement characters.
      charge(jsonStringBytes(item)); if (Buffer.from(item).toString('utf8') !== item) fail();
      return item;
    }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fail();
    ancestors.add(item);
    if (Array.isArray(item)) {
      const values = list(item, 50_000); charge(2 + Math.max(values.length - 1, 0));
      const result = values.map(child => visit(child, depth + 1)); ancestors.delete(item); return result;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) fail();
    const result: Record<string, unknown> = {};
    const keys = Reflect.ownKeys(item);
    if (keys.length > 50_000) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    charge(2 + Math.max(keys.length - 1, 0));
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      charge(jsonStringBytes(key) + 1);
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function semanticBody(value: Pick<WorkspaceOperationNativeSourceEvidence, 'workspaceScope' | 'stage' | 'nativeBindings'>): unknown {
  const { stageProof: _historical, namespace, ...stage } = value.stage;
  return { workspaceScope: value.workspaceScope, stage: { ...stage, namespace: namespace.map(entry => {
    if (entry.kind === 'file' && entry.documentId !== null) return { ...entry, filesystemIdentity: null };
    if (entry.kind === 'directory' && entry.filesystemIdentity !== null) {
      const parts = entry.filesystemIdentity.split(':');
      return { ...entry, identity: `directory:${parts[0]}:${parts[1]}`, filesystemIdentity: null };
    }
    return entry;
  }) }, nativeBindings: value.nativeBindings };
}
function semanticBodyV2(value: Pick<WorkspaceOperationNativeSourceEvidenceV2,
  'workspaceScope' | 'stage' | 'nativeBindings' | 'semanticCatalogueProof'>): unknown {
  const normalized = semanticBody(value) as {
    workspaceScope: WorkspaceOperationJobScope;
    stage: Omit<NativeStage, 'stageProof'>;
    nativeBindings: readonly WorkspaceNativeSourceBinding[];
  };
  return { semanticVersion: 2, ...normalized,
    stage: { ...normalized.stage, catalogueProof: value.semanticCatalogueProof },
    // V2 capture bound every one of these documents to its complete original
    // catalogue row before deriving either replaceable registry clock.
    nativeBindings: normalized.nativeBindings.map(binding => ({ ...binding,
      expected: { ...binding.expected, registryStateVersion: 0 },
      registry: { ...binding.registry, stateVersion: 0 } })) };
}
function semanticHtmlBodyV4(value: Pick<WorkspaceOperationNativeHtmlSourceEvidenceV4,
  'workspaceScope' | 'stage' | 'nativeBindings' | 'semanticCatalogueProof' | 'htmlSources'>): unknown {
  return { ...semanticBodyV2(value) as Record<string, unknown>, semanticVersion: 4, htmlSources: value.htmlSources };
}
function vector(value: unknown, maximum = MAX_VECTOR_BYTES): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) fail();
  return bytes;
}
function fingerprint(value: unknown): value is string {
  if (!text(value, 256)) return false;
  const parts = value.split(':');
  return parts.length === 5 && parts.slice(0, 3).every(part => /^(?:0|[1-9][0-9]*)$/u.test(part) && Number.isSafeInteger(Number(part)))
    && parts.slice(3).every(part => /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(part) && Number.isFinite(Number(part)));
}
/** Shared pure fact validation; it grants no filesystem or writer authority. */
export { fingerprint as isNativeSourceFilesystemFingerprint };
function complete(value: unknown): void {
  const row = record(value, ['complete', 'gaps']);
  if (row.complete !== true || list(row.gaps, 0).length) fail();
}
function inspectHtmlInventoryCoverage(inventory: Pick<NativeDocumentLinkInventory, 'coverage' | 'document'>): void {
  const coverage = record(inventory.coverage, ['complete', 'gaps']);
  const gaps = list(coverage.gaps, MAX_LINKS);
  if (coverage.complete !== (gaps.length === 0)) fail();
  for (const value of gaps) {
    const gap = record(value, ['code', 'path', 'raw'], ['htmlTargets']);
    if (gap.code !== 'uninspected-html' || gap.path !== inventory.document.path || !text(gap.raw, MAX_EVIDENCE_BYTES) || !gap.raw) fail();
    const actual = evaluateWorkspaceHtmlLinks(gap.raw);
    if (!actual.unevaluated || nativeLinkJsonProof(gap.htmlTargets ?? null) !== nativeLinkJsonProof(actual.explicitLocalTargets ?? null)) fail();
  }
}
function inspectInventoryCoverageV4(inventory: NativeDocumentLinkInventoryV4): void {
  const coverage = record(inventory.coverage, ['complete', 'gaps']);
  const gaps = list(coverage.gaps, MAX_LINKS);
  if (coverage.complete !== (gaps.length === 0)) fail();
  for (const value of gaps) {
    const gap = record(value, ['code', 'path'], ['nodeId', 'attribute', 'raw', 'htmlTargets']);
    if (!['unknown-node', 'unknown-mark', 'unknown-attribute', 'invalid-target', 'unsupported-target',
      'invalid-frontmatter', 'limit-exceeded', 'unreadable-source', 'uninitialized-source', 'identity-conflict',
      'uninspected-html', 'unsupported-source'].includes(String(gap.code)) || gap.path !== inventory.document.path
      || gap.nodeId !== undefined && !id(gap.nodeId) || gap.attribute !== undefined && !text(gap.attribute)
      || gap.raw !== undefined && !text(gap.raw, MAX_EVIDENCE_BYTES)) fail();
    if (gap.code === 'uninspected-html') {
      if (typeof gap.raw !== 'string' || !gap.raw) fail();
      const actual = inspectWorkspaceStaticHtmlLinks(gap.raw);
      if (actual.fullyInspected && actual.explicitLocalTargets.length === 0
        || (!actual.fullyInspected || actual.explicitLocalTargets.length === 0) && Object.hasOwn(gap, 'htmlTargets')
        || nativeLinkJsonProof(gap.htmlTargets ?? null) !== nativeLinkJsonProof(actual.fullyInspected && actual.explicitLocalTargets.length
          ? actual.explicitLocalTargets : null)) fail();
    } else if (Object.hasOwn(gap, 'htmlTargets')) fail();
  }
}

function inspectInventory(inventory: NativeDocumentLinkInventory | NativeDocumentLinkInventoryV4, html = false, parserPolicy: 2 | 4 = 2): void {
  record(inventory, ['contractVersion', 'document', 'version', 'parserVersion', 'metadata', 'links', 'coverage']);
  record(inventory.document, ['documentId', 'workspaceId', 'organizationId', 'path', 'lifecycleGeneration', 'representation', 'schemaVersion']);
  record(inventory.version, ['stateVector', 'stateProof', 'documentSequence', 'persistedAt']);
  if (parserPolicy === 4) {
    if (inventory.parserVersion !== 4) fail();
    inspectInventoryCoverageV4(inventory);
  }
  else if (html) inspectHtmlInventoryCoverage(inventory); else complete(inventory.coverage);
  const metadata = record(inventory.metadata, ['aliases', 'blockIds', 'headings', 'hasExplicitTitle', 'path', 'tags', 'title']);
  if (metadata.path !== inventory.document.path || typeof metadata.hasExplicitTitle !== 'boolean' || !text(metadata.title)) fail();
  for (const name of ['aliases', 'blockIds', 'tags']) if (list(metadata[name], MAX_LINKS).some(value => !text(value))) fail();
  for (const value of list(metadata.headings, MAX_LINKS)) {
    const heading = record(value, ['depth', 'text']);
    if (!integer(heading.depth, 1) || heading.depth > 6 || !text(heading.text)) fail();
  }
  const seen = new Set<string>(), ordinals = new Map<string, number>(); let linkAttributes: string[] | undefined;
  for (const value of list(inventory.links, MAX_LINKS)) {
    const link = value as NativeDocumentLink;
    record(link, ['id', 'kind', 'syntax', 'literal', 'targetPathText', 'fragment', 'alias', 'embed', 'classification', 'ref', 'cloneLocator']);
    if (!text(link.literal) || !text(link.targetPathText) || link.fragment !== null && !text(link.fragment)
      || link.alias !== null && !text(link.alias) || typeof link.embed !== 'boolean'
      || !['local', 'external', 'anchor-only'].includes(link.classification)
      || !['wiki', 'markdown'].includes(link.kind)
      || !(link.kind === 'wiki' ? ['wiki-link', 'wiki-embed']
        : ['inline-link', 'inline-image', 'reference-link', 'reference-image', 'reference-definition']).includes(link.syntax)) fail();
    const ref = link.ref;
    let identity: unknown, ownerBlockId: string | null, nodeId: string | null;
    if (ref.kind === 'node-attribute') {
      record(ref, ['kind', 'ownerBlockId', 'nodeId', 'attribute', 'expected', 'membershipAnchor']);
      if (!nullableId(ref.ownerBlockId) || !id(ref.nodeId) || !['target', 'src'].includes(ref.attribute) || !text(ref.expected)
        || ref.membershipAnchor !== null && !vector(ref.membershipAnchor, 16_384)) fail();
      ownerBlockId = ref.ownerBlockId; nodeId = ref.nodeId;
      identity = { kind: ref.kind, ownerBlockId, nodeId, attribute: ref.attribute, membershipAnchor: ref.membershipAnchor };
    } else {
      record(ref, ref.kind === 'plain-target' ? ['kind', 'text', 'expected', 'syntaxText', 'syntaxStart', 'syntaxEnd', 'targetStart', 'targetEnd', 'raw']
        : ['kind', 'text', 'expected']);
      if (!['plain-target', 'link-mark'].includes(ref.kind)) fail();
      const reference = (input: unknown) => {
        const row = record(input, ['blockId', 'startAnchor', 'endAnchor']);
        if (!nullableId(row.blockId)) fail(); vector(row.startAnchor, 16_384); vector(row.endAnchor, 16_384);
      };
      reference(ref.text); ownerBlockId = ref.text.blockId; nodeId = null;
      if (ref.kind === 'plain-target') {
        reference(ref.syntaxText);
        if (inventory.document.representation !== 'plain_text' || ref.text.blockId !== null || ref.syntaxText.blockId !== null
          || ref.expected !== link.literal || !text(ref.raw) || ![ref.syntaxStart, ref.syntaxEnd, ref.targetStart, ref.targetEnd].every(value => integer(value))
          || ref.syntaxStart > ref.targetStart || ref.targetStart > ref.targetEnd || ref.targetEnd > ref.syntaxEnd
          || ref.raw.length !== ref.syntaxEnd - ref.syntaxStart || ref.expected.length !== ref.targetEnd - ref.targetStart
          || ref.raw.slice(ref.targetStart - ref.syntaxStart, ref.targetEnd - ref.syntaxStart) !== ref.expected) fail();
      } else {
        if (inventory.document.representation === 'plain_text') fail();
        linkAttributes ??= Object.keys(getNativeInspectionSchema().marks.link.spec.attrs ?? {});
        const attrs = record(ref.expected, [], linkAttributes);
        if (attrs.href !== link.literal || Object.values(attrs).some(value => value !== null && !text(value))) fail();
      }
      identity = { kind: ref.kind, text: ref.text };
    }
    if (inventory.document.representation === 'plain_text' && ref.kind !== 'plain-target') fail();
    const locator = record(link.cloneLocator, ['ownerBlockId', 'nodeId', 'ordinal']);
    const key = `${ownerBlockId ?? ''}:${nodeId ?? ''}:${ref.kind}`, ordinal = ordinals.get(key) ?? 0;
    if (locator.ownerBlockId !== ownerBlockId || locator.nodeId !== nodeId || locator.ordinal !== ordinal
      || link.id !== `${inventory.document.documentId}:${inventory.document.lifecycleGeneration}:${nativeLinkJsonProof(identity)}` || seen.has(link.id)) fail();
    ordinals.set(key, ordinal + 1); seen.add(link.id);
  }
}

/** Explicit parser-4 historical facts only. A caller must separately bind the
 * decoded inventory to freshly verified native bytes before any execution. */
export function decodeNativeInventoryV4Facts(input: unknown): NativeDocumentLinkInventoryV4 {
  try {
    const value = plainJson(input) as NativeDocumentLinkInventoryV4;
    record(value, ['contractVersion', 'document', 'version', 'parserVersion', 'metadata', 'links', 'coverage']);
    record(value.document, ['documentId', 'workspaceId', 'organizationId', 'path', 'lifecycleGeneration', 'representation', 'schemaVersion']);
    record(value.version, ['stateVector', 'stateProof', 'documentSequence', 'persistedAt']);
    const document = value.document, version = value.version;
    if (value.contractVersion !== 2 || value.parserVersion !== 4 || !id(document.documentId) || !id(document.workspaceId)
      || !nullableId(document.organizationId) || !canonicalPath(document.path) || !integer(document.lifecycleGeneration, 1)
      || !representations.includes(document.representation) || document.schemaVersion !== COLLABORATION_SCHEMA_VERSION
      || !integer(version.documentSequence) || !integer(version.persistedAt) || !isCollaborationStateProof(version.stateProof)) fail();
    vector(version.stateVector);
    inspectInventory(value, false, 4);
    return freeze(value);
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail(error instanceof RangeError ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
  }
}
/** Historical positions are bounded facts, not a claim that these offsets were
 * read from a current document. Fresh capture below repeats the complete AST
 * inspection from actual verified native bytes before a current comparison. */
function inspectHtmlSources(value: WorkspaceOperationNativeHtmlSourceEvidenceV4): void {
  const rows = list(value.htmlSources, MAX_PATHS);
  if (rows.length !== value.nativeBindings.length) fail();
  let remaining = MAX_LINKS, remainingTargets = MAX_LINKS;
  const seen = new Set<string>();
  const sources = new Map(value.stage.sources.map(source => [source.inventory.document.documentId, source.inventory]));
  const bindings = new Map(value.nativeBindings.map(binding => [binding.expected.documentId, binding]));
  for (const raw of rows) {
    const row = record(raw, ['documentId', 'path', 'inventoryProof', 'inspection']);
    if (!id(row.documentId) || seen.has(row.documentId) || !canonicalPath(row.path) || !digest(row.inventoryProof)) fail();
    seen.add(row.documentId);
    const source = sources.get(row.documentId);
    const binding = bindings.get(row.documentId);
    if (!source || !binding || row.path !== binding.expected.path || row.inventoryProof !== binding.inventoryProof) fail();
    const inspection = record(row.inspection, ['parserVersion', 'occurrences']);
    if (inspection.parserVersion !== 4) fail();
    const occurrences = list(inspection.occurrences, MAX_LINKS);
    remaining -= occurrences.length; if (remaining < 0) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
    if (source.document.representation !== 'plain_text' && occurrences.length) fail();
    let previousEnd = 0;
    for (const input of occurrences) {
      const occurrence = record(input, ['sourcePath', 'start', 'end', 'raw', 'fullyInspected', 'explicitLocalTargets']);
      if (occurrence.sourcePath !== row.path || !integer(occurrence.start) || !integer(occurrence.end)
        || occurrence.start < previousEnd || occurrence.end > MAX_BINARY_BYTES || !text(occurrence.raw, MAX_EVIDENCE_BYTES) || !occurrence.raw
        || occurrence.end - occurrence.start !== occurrence.raw.length || typeof occurrence.fullyInspected !== 'boolean') fail();
      previousEnd = occurrence.end;
      const targets = list(occurrence.explicitLocalTargets, MAX_LINKS);
      if (targets.some(target => !text(target))) fail();
      remainingTargets -= targets.length;
      if (remainingTargets < 0) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
      const actual = inspectWorkspaceStaticHtmlLinks(occurrence.raw, targets.length);
      if (actual.fullyInspected !== occurrence.fullyInspected
        || nativeLinkJsonProof(actual.explicitLocalTargets) !== nativeLinkJsonProof(targets)) fail();
    }
    // Parser 2 inventories retain historical BOM offsets and Wiki handling;
    // parser 4 intentionally inspects the current visible grammar. These are
    // separately bound facts. Only fresh capture can establish that BOTH were
    // derived from the same actual native binary; this decoder cannot do so.
  }
}
function inspect(value: NativeEvidenceFacts, verifyProofs = true, html = false): void {
  record(value, ['evidenceVersion', 'workspaceScope', 'stage', 'nativeBindings', 'semanticProof', 'evidenceProof',
    ...(value.evidenceVersion === 2 || html ? ['semanticCatalogueProof'] : []), ...(html ? ['htmlSources'] : [])]);
  const { workspaceScope: scope, stage, nativeBindings: bindings } = value;
  parseWorkspaceOperationJobScope(scope);
  record(stage, ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace', 'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof']);
  record(stage.scope, ['kind', 'excludedPaths']);
  if (html) {
    const coverage = record(stage.coverage, ['complete', 'gaps']);
    const actual = stage.sources.flatMap(source => source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })));
    if (coverage.complete !== (actual.length === 0) || nativeLinkJsonProof(coverage.gaps) !== nativeLinkJsonProof(actual)) fail();
  } else complete(stage.coverage);
  if ((html ? value.evidenceVersion !== 4 : value.evidenceVersion !== 1 && value.evidenceVersion !== 2)
    || (value.evidenceVersion === 2 || value.evidenceVersion === 4) && !digest(value.semanticCatalogueProof)
    || scope.legacy !== false || !canonicalPath(scope.rootRelativePath)
    || !id(scope.workspaceId) || ![scope.organizationId, scope.customerId, scope.projectId, scope.ownerUserId].every(nullableId)
    || stage.stageVersion !== 1 || stage.workspaceId !== scope.workspaceId || stage.organizationId !== scope.organizationId
    || !digest(stage.catalogueProof) || stage.executionReady !== false || !html && (!stage.coverage?.complete || stage.coverage.gaps.length)
    || stage.scope.kind !== 'visible-workspace' || !digest(value.semanticProof) || !digest(value.evidenceProof)
    || list(stage.sources, MAX_PATHS).length !== list(bindings, MAX_PATHS).length) fail();
  const exclusions = list(stage.scope.excludedPaths, MAX_PATHS);
  if (exclusions.some(value => !canonicalPath(value)) || new Set(exclusions).size !== exclusions.length) fail();
  for (const source of stage.sources) {
    record(source, ['kind', 'inventory']);
    if (source.kind !== 'native') fail('NATIVE_SOURCE_IMPORT_REQUIRED'); inspectInventory(source.inventory, html);
  }
  if (stage.readiness !== (html && stage.coverage.gaps.length ? 'blocked' : 'native-coordinator-required')
    || workspaceSourceAuthorityStageProof(stage) !== stage.stageProof) fail();
  const sources = new Map(stage.sources.map(source => [source.inventory.document.documentId, source.inventory]));
  const paths = new Set<string>(), ids = new Set<string>(), lineages = new Set<string>();
  if (sources.size !== stage.sources.length) fail();
  for (const binding of bindings) {
    record(binding, ['expected', 'registry', 'lineage', 'byteProfile', 'inventoryProof']);
    record(binding.expected, ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion',
      'lifecycleGeneration', 'registryStateVersion', 'documentSequence', 'persistedAt', 'stateProof', 'binaryHash', 'vectorHash']);
    record(binding.registry, ['documentId', 'lineageId', 'workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId',
      'path', 'provider', 'stateLifecycle', 'stateVersion', 'status']);
    record(binding.lineage, ['lineageId', 'workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId',
      'path', 'status', 'archivedAt', 'trashEntryId']);
    record(binding.byteProfile, ['newlineStyle', 'hasBom']);
    const expected = binding.expected, inventory = sources.get(expected.documentId);
    if (!inventory || !id(expected.documentId) || !id(expected.lineageId) || ids.has(expected.documentId) || lineages.has(expected.lineageId)
      || paths.has(expected.path) || !canonicalPath(expected.path)
      || expected.workspaceId !== scope.workspaceId || expected.organizationId !== scope.organizationId
      || !representations.includes(expected.representation) || expected.schemaVersion !== COLLABORATION_SCHEMA_VERSION
      || !integer(expected.lifecycleGeneration, 1) || !integer(expected.registryStateVersion) || !integer(expected.documentSequence)
      || expected.registryStateVersion > expected.documentSequence || !integer(expected.persistedAt)
      || !isCollaborationStateProof(expected.stateProof) || !digest(expected.binaryHash) || !digest(expected.vectorHash)
      || inventory.contractVersion !== 2 || inventory.parserVersion !== 2 || !html && (!inventory.coverage.complete || inventory.coverage.gaps.length)
      || nativeLinkJsonProof(inventory) !== binding.inventoryProof
      || inventory.document.documentId !== expected.documentId || inventory.document.path !== expected.path
      || inventory.document.workspaceId !== scope.workspaceId || inventory.document.organizationId !== scope.organizationId
      || inventory.document.lifecycleGeneration !== expected.lifecycleGeneration || inventory.document.representation !== expected.representation
      || inventory.document.schemaVersion !== expected.schemaVersion || inventory.version.documentSequence !== expected.documentSequence
      || inventory.version.persistedAt !== expected.persistedAt || inventory.version.stateProof !== expected.stateProof) fail();
    for (const row of [binding.registry, binding.lineage]) {
      if (row.workspaceId !== scope.workspaceId || row.workspaceType !== scope.workspaceType || row.organizationId !== scope.organizationId
        || row.customerId !== null && row.customerId !== scope.customerId || row.projectId !== null && row.projectId !== scope.projectId
        || row.path !== expected.path || row.status !== 'active' || row.lineageId !== expected.lineageId) fail();
    }
    if (binding.registry.documentId !== expected.documentId || binding.registry.provider !== 'yjs'
      || binding.registry.stateLifecycle !== 'initialized' || binding.registry.stateVersion !== expected.registryStateVersion
      || binding.lineage.archivedAt !== null || !nullableId(binding.lineage.trashEntryId) || !['lf', 'crlf'].includes(binding.byteProfile.newlineStyle)
      || typeof binding.byteProfile.hasBom !== 'boolean') fail();
    if (sha(vector(inventory.version.stateVector)) !== expected.vectorHash) fail();
    ids.add(expected.documentId); lineages.add(expected.lineageId); paths.add(expected.path);
  }
  const nativeParents = new Set<string>();
  for (const nativePath of paths) {
    const segments = nativePath.split('/'); segments.pop();
    while (segments.length) { nativeParents.add(segments.join('/')); segments.pop(); }
  }
  const namespacePaths = new Set<string>();
  const namespace = list(stage.namespace, MAX_PATHS) as NativeStage['namespace'];
  for (const entry of namespace) {
    record(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity']);
    if (entry.workspaceId !== scope.workspaceId || !canonicalPath(entry.path) || namespacePaths.has(entry.path)
      || !['file', 'directory'].includes(entry.kind) || !text(entry.identity, 1024) || !entry.identity
      || entry.filesystemIdentity !== null && !fingerprint(entry.filesystemIdentity)) fail();
    if (entry.documentId !== null && (entry.kind !== 'file' || !ids.has(entry.documentId)
      || sources.get(entry.documentId)?.document.path !== entry.path
      || sources.get(entry.documentId)?.document.lifecycleGeneration !== entry.lifecycleGeneration
      || entry.identity !== `registry:${entry.documentId}:${entry.lifecycleGeneration}`)) fail();
    if (entry.kind === 'directory' && (entry.documentId !== null || entry.lifecycleGeneration !== null)) fail();
    if (entry.documentId === null) {
      if (entry.lifecycleGeneration !== null) fail();
      if (entry.filesystemIdentity !== null) { if (entry.identity !== entry.filesystemIdentity) fail(); }
      else if (entry.kind !== 'directory' || !nativeParents.has(entry.path)
        || entry.identity !== `registry-directory:${nativeLinkJsonProof({ workspaceId: scope.workspaceId, path: entry.path })}`) fail();
      if (entry.kind === 'file' && /\.(?:md|markdown|html?|mdx)$/iu.test(entry.path)) fail('NATIVE_SOURCE_IMPORT_REQUIRED');
    }
    namespacePaths.add(entry.path);
  }
  const byPath = new Map(namespace.map(entry => [entry.path, entry]));
  for (const entry of namespace) {
    const segments = entry.path.split('/'); segments.pop();
    while (segments.length) { if (byPath.get(segments.join('/'))?.kind !== 'directory') fail(); segments.pop(); }
  }
  for (const binding of bindings) {
    const entry = byPath.get(binding.expected.path);
    if (entry?.documentId !== binding.expected.documentId || entry.kind !== 'file') fail();
  }
  if (html) inspectHtmlSources(value as WorkspaceOperationNativeHtmlSourceEvidenceV4);
  if (!verifyProofs) return;
  if (nativeLinkJsonProof(value.evidenceVersion === 4 ? semanticHtmlBodyV4(value)
    : value.evidenceVersion === 2 ? semanticBodyV2(value) : semanticBody(value)) !== value.semanticProof) fail();
  const { evidenceProof, ...body } = value;
  if (nativeLinkJsonProof(body) !== evidenceProof) fail();
}

/** Pure historical facts. A freshly collected same-B observation is still
 * required before every mutation; this decoder does not create a capability. */
export function decodeWorkspaceOperationNativeSourceEvidence(input: WorkspaceOperationNativeSourceEvidenceV1): WorkspaceOperationNativeSourceEvidenceV1;
export function decodeWorkspaceOperationNativeSourceEvidence(input: WorkspaceOperationNativeSourceEvidenceV2): WorkspaceOperationNativeSourceEvidenceV2;
export function decodeWorkspaceOperationNativeSourceEvidence(input: unknown): WorkspaceOperationNativeSourceEvidence;
export function decodeWorkspaceOperationNativeSourceEvidence(input: unknown): WorkspaceOperationNativeSourceEvidence {
  try {
    const value = plainJson(input) as WorkspaceOperationNativeSourceEvidence;
    inspect(value); return freeze(value);
  } catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return fail(); }
}

const stateKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'lifecycleGeneration', 'schemaVersion',
  'yjsState', 'stateVector', 'documentSequence', 'persistedAt', 'checkpointedAt', 'checkpointSequence', 'canonicalHash',
  'serializedHash', 'newlineStyle', 'hasBom', 'degraded', 'status'] as const;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
function copyBytes(input: unknown, maximum: number, budget: { remaining: number }): Uint8Array {
  if (!input || !ArrayBuffer.isView(input) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
    || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(key => Object.hasOwn(input, key))) fail();
  const length = typedLength.call(input) as number, buffer = typedBuffer.call(input) as ArrayBuffer;
  if (!integer(length, 1)) fail();
  if (length > maximum || length > budget.remaining) fail('NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
  if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) fail();
  budget.remaining -= length;
  const captured = new Uint8Array(length); Uint8Array.prototype.set.call(captured, input as Uint8Array); return captured;
}
function captureState(input: unknown, budget: { remaining: number }, jsonBudget: JsonBudget): PersistedCollaborationState {
  const row = record(input, stateKeys, ['projectionError', 'projectionFinalized']);
  const yjsState = copyBytes(row.yjsState, MAX_BINARY_BYTES, budget), stateVector = copyBytes(row.stateVector, MAX_VECTOR_BYTES, budget);
  delete row.yjsState; delete row.stateVector;
  if (row.projectionError === undefined) delete row.projectionError;
  if (row.projectionFinalized === undefined) delete row.projectionFinalized;
  const data = plainJson(row, jsonBudget) as Omit<PersistedCollaborationState, 'yjsState' | 'stateVector'>;
  if (!integer(data.checkpointSequence) || data.checkpointSequence > data.documentSequence
    || data.checkpointedAt !== null && !integer(data.checkpointedAt) || typeof data.degraded !== 'boolean'
    || typeof data.hasBom !== 'boolean' || !['lf', 'crlf'].includes(data.newlineStyle)
    || [data.canonicalHash, data.serializedHash].some(value => value !== null && !text(value, 256))
    || data.projectionFinalized !== undefined && typeof data.projectionFinalized !== 'boolean') fail();
  if (data.projectionError) {
    const error = record(data.projectionError, ['code', 'sequence', 'permanent'], ['phase']);
    if (!id(error.code) || !integer(error.sequence) || error.sequence > data.documentSequence || typeof error.permanent !== 'boolean'
      || Object.hasOwn(error, 'phase') && (!text(error.phase, 256) || /[\u0000-\u001f\u007f]/u.test(error.phase))) fail();
  } else if (Object.hasOwn(data, 'projectionError')) fail();
  return { ...data, yjsState, stateVector };
}
/** Same binary, identity, schema and inventory validation for both explicit
 * fact contracts. No caller can substitute projected Markdown for these bytes. */
function captureAndAssertNativeEvidenceStates(evidence: NativeEvidenceFacts, supplied: unknown): Map<string, PersistedCollaborationState> {
  const boundScope = evidence.workspaceScope;
  const rawStates = list(supplied, MAX_PATHS);
  if (rawStates.length !== evidence.nativeBindings.length) fail();
  const budget = { remaining: MAX_PRIVATE_BYTES }, jsonBudget = { remaining: MAX_EVIDENCE_BYTES, nodes: 200_000 };
  const states = new Map<string, PersistedCollaborationState>();
  for (const raw of rawStates) {
    const state = captureState(raw, budget, jsonBudget);
    if (states.has(state.documentId)) fail(); states.set(state.documentId, state);
  }
  for (const binding of evidence.nativeBindings) {
    const state = states.get(binding.expected.documentId);
    if (!state || state.workspaceId !== boundScope.workspaceId || state.organizationId !== boundScope.organizationId
      || state.path !== binding.expected.path || state.lifecycleGeneration !== binding.expected.lifecycleGeneration
      || state.representation !== binding.expected.representation || state.schemaVersion !== binding.expected.schemaVersion
      || state.documentSequence !== binding.expected.documentSequence || state.persistedAt !== binding.expected.persistedAt
      || state.status !== 'active' || state.newlineStyle !== binding.byteProfile.newlineStyle || state.hasBom !== binding.byteProfile.hasBom
      || sha(state.yjsState) !== binding.expected.binaryHash || sha(state.stateVector) !== binding.expected.vectorHash) fail();
    const inventory = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
      assertNativeDocumentSchema(doc, state.representation, getNativeInspectionSchema());
      return inspectNativeDocumentLinks(doc, snapshot);
    });
    if (nativeLinkJsonProof(inventory) !== binding.inventoryProof) fail();
  }
  return states;
}
export function captureWorkspaceOperationNativeSourceEvidence(scope: WorkspaceOperationJobScope,
  observation: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationNativeSourceEvidenceV1 {
  try {
    const observationData = record(observation, ['stage', 'nativeBindings', 'privateNativeStates'], ['privateCatalogue']);
    const stageData = record(observationData.stage, ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace',
      'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof']);
    for (const source of list(stageData.sources, MAX_PATHS)) {
      if (record(source, ['kind', 'inventory']).kind === 'physical') fail('NATIVE_SOURCE_IMPORT_REQUIRED');
    }
    const facts = plainJson({ workspaceScope: scope, stage: observationData.stage, nativeBindings: observationData.nativeBindings }) as
    Pick<WorkspaceOperationNativeSourceEvidence, 'workspaceScope' | 'stage' | 'nativeBindings'>;
    // Validate shapes before semanticBody accesses nested DTOs. Hash placeholders
    // are replaced only after this rejection-only validation has completed.
    const preliminary = { evidenceVersion: 1 as const, ...facts, semanticProof: '0'.repeat(64), evidenceProof: '0'.repeat(64) };
    inspect(preliminary, false);
    if (Object.hasOwn(observationData, 'privateCatalogue')) {
      // This complete transient witness is validated independently of the
      // persisted evidence budget. It never becomes serialized stage data.
      captureWorkspaceOperationNativeCatalogueWitness(observationData.privateCatalogue, facts.workspaceScope,
        facts.stage.catalogueProof!, facts.nativeBindings, reason => fail(reason === 'too-large'
          ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID'));
    }
    const body = { ...preliminary, semanticProof: nativeLinkJsonProof(semanticBody(facts)) };
    const { evidenceProof: _placeholder, ...withoutProof } = body;
    const evidence = decodeWorkspaceOperationNativeSourceEvidence({ ...withoutProof, evidenceProof: nativeLinkJsonProof(withoutProof) });
    captureAndAssertNativeEvidenceStates(evidence, observationData.privateNativeStates);
    return evidence;
  } catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return fail(); }
}
/** V2 requires the actual complete transient catalogue. Its raw scope, stage,
 * bindings and native bytes still pass the unchanged V1 capture first. */
export function captureWorkspaceOperationNativeSourceEvidenceV2(scope: WorkspaceOperationJobScope,
  observation: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationNativeSourceEvidenceV2 {
  try {
    const captured = record(observation, ['stage', 'nativeBindings', 'privateNativeStates', 'privateCatalogue']);
    const legacy = captureWorkspaceOperationNativeSourceEvidence(scope, {
      stage: captured.stage, nativeBindings: captured.nativeBindings, privateNativeStates: captured.privateNativeStates,
    } as WorkspaceLinkSourceAuthorityObservation);
    const witness = captureWorkspaceOperationNativeCatalogueWitness(captured.privateCatalogue, legacy.workspaceScope,
      legacy.stage.catalogueProof!, legacy.nativeBindings, reason => fail(reason === 'too-large'
        ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID'));
    const facts = { evidenceVersion: 2 as const, workspaceScope: legacy.workspaceScope,
      stage: legacy.stage, nativeBindings: legacy.nativeBindings, semanticCatalogueProof: witness.semanticCatalogueProof };
    const body = { ...facts, semanticProof: nativeLinkJsonProof(semanticBodyV2(facts)) };
    return decodeWorkspaceOperationNativeSourceEvidence({ ...body, evidenceProof: nativeLinkJsonProof(body) });
  } catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return fail(); }
}

/** HTML facts are a separate, deliberately non-executable component. Its
 * original inventory gaps remain false/incomplete and no V1/V2 plan accepts it. */
export function decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(input: unknown): WorkspaceOperationNativeHtmlSourceEvidenceV4 {
  try {
    const value = plainJson(input) as WorkspaceOperationNativeHtmlSourceEvidenceV4;
    inspect(value, true, true); return freeze(value);
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail(error instanceof RangeError ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
  }
}

/** Every native state and the complete private catalogue are actually verified.
 * The inspection uses Plain Y.Text content only, never a Rich serialization. */
export function captureWorkspaceOperationNativeHtmlSourceEvidenceV4(scope: WorkspaceOperationJobScope,
  observation: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationNativeHtmlSourceEvidenceV4 {
  try {
    const raw = record(observation, ['stage', 'nativeBindings', 'privateNativeStates', 'privateCatalogue']);
    const stage = record(raw.stage, ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace',
      'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof']);
    for (const source of list(stage.sources, MAX_PATHS)) {
      if (record(source, ['kind', 'inventory']).kind !== 'native') fail('NATIVE_SOURCE_IMPORT_REQUIRED');
    }
    const facts = plainJson({ workspaceScope: scope, stage: raw.stage, nativeBindings: raw.nativeBindings }) as
      Pick<WorkspaceOperationNativeSourceEvidence, 'workspaceScope' | 'stage' | 'nativeBindings'>;
    const preliminary: WorkspaceOperationNativeHtmlSourceEvidenceV4 = { evidenceVersion: 4, ...facts,
      semanticCatalogueProof: '0'.repeat(64), semanticProof: '0'.repeat(64), evidenceProof: '0'.repeat(64), htmlSources: [] };
    const states = captureAndAssertNativeEvidenceStates(preliminary, raw.privateNativeStates);
    const htmlSources: WorkspaceOperationNativeHtmlSourceEvidenceV4['htmlSources'][number][] = [];
    let maximumOccurrences = MAX_LINKS, maximumTargets = MAX_LINKS;
    for (const binding of facts.nativeBindings) {
      const state = states.get(binding.expected.documentId)!;
      const inspection = inspectPersistedNativeCollaborationSnapshot(state, (_doc, snapshot) => snapshot.content.kind === 'plain_text'
        ? inspectWorkspaceMarkdownHtmlV4(snapshot.content.text, state.path, { maximumOccurrences, maximumTargets })
        : { parserVersion: 4 as const, occurrences: [] });
      maximumOccurrences -= inspection.occurrences.length;
      maximumTargets -= inspection.occurrences.reduce((count, occurrence) => count + occurrence.explicitLocalTargets.length, 0);
      htmlSources.push({ documentId: state.documentId, path: state.path, inventoryProof: binding.inventoryProof, inspection });
    }
    inspect({ ...preliminary, htmlSources }, false, true);
    const witness = captureWorkspaceOperationNativeCatalogueWitness(raw.privateCatalogue, facts.workspaceScope,
      facts.stage.catalogueProof!, facts.nativeBindings, reason => fail(reason === 'too-large'
        ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID'));
    const bodyFacts = { evidenceVersion: 4 as const, ...facts, htmlSources, semanticCatalogueProof: witness.semanticCatalogueProof };
    const body = { ...bodyFacts, semanticProof: nativeLinkJsonProof(semanticHtmlBodyV4(bodyFacts)) };
    return decodeWorkspaceOperationNativeHtmlSourceEvidenceV4({ ...body, evidenceProof: nativeLinkJsonProof(body) });
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return fail(error instanceof RangeError ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
  }
}

/** No witnessless or V1 compatibility fallback exists for HTML-aware facts. */
export function assertWorkspaceOperationNativeHtmlSourceEvidenceV4Current(expected: WorkspaceOperationNativeHtmlSourceEvidenceV4,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(expected);
  const current = captureWorkspaceOperationNativeHtmlSourceEvidenceV4(scope, observation);
  if (original.semanticProof !== current.semanticProof) fail('NATIVE_SOURCE_EVIDENCE_CHANGED');
}
export function assertWorkspaceOperationNativeSourceEvidenceCurrent(expected: WorkspaceOperationNativeSourceEvidence,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationNativeSourceEvidence(expected);
  if (original.evidenceVersion === 2) {
    try {
      const captured = record(observation, ['stage', 'nativeBindings', 'privateNativeStates'], ['privateCatalogue']);
      if (Object.hasOwn(captured, 'privateCatalogue')) {
        const current = captureWorkspaceOperationNativeSourceEvidenceV2(scope, captured as WorkspaceLinkSourceAuthorityObservation);
        if (original.semanticProof !== current.semanticProof) fail('NATIVE_SOURCE_EVIDENCE_CHANGED');
        return;
      }
      // Historical Stage/Records replay has no catalogue witness. It may only
      // reproduce all original raw facts, after validating the actual bytes;
      // absence never enables projection or registry-clock tolerance.
      const current = captureWorkspaceOperationNativeSourceEvidence(scope, captured as WorkspaceLinkSourceAuthorityObservation);
      const raw = (value: WorkspaceOperationNativeSourceEvidence) => ({ workspaceScope: value.workspaceScope,
        stage: value.stage, nativeBindings: value.nativeBindings });
      if (nativeLinkJsonProof(raw(original)) !== nativeLinkJsonProof(raw(current))) fail('NATIVE_SOURCE_EVIDENCE_CHANGED');
      return;
    } catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return fail(); }
  }
  const current = captureWorkspaceOperationNativeSourceEvidence(scope, observation);
  if (original.semanticProof !== current.semanticProof) fail('NATIVE_SOURCE_EVIDENCE_CHANGED');
}

/** Internal historical byte/inventory validation only. The supplied evidence
 * must first pass its strict versioned decoder. This does not capture a current
 * catalogue, SQL principal, namespace, admission, or publication capability. */
export function captureNativeCopyHtmlOriginalStates(evidence: WorkspaceOperationNativeHtmlSourceEvidenceV4,
  supplied: unknown): ReadonlyMap<string, PersistedCollaborationState> {
  return captureAndAssertNativeEvidenceStates(decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(evidence), supplied);
}
