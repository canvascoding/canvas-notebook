import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { assertNativeDocumentSchema } from '../collaboration/native-document-schema';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../markdown/workspace-link-limits';
import { inspectWorkspaceStaticHtmlLinks } from '../markdown/workspace-html-link-safety';
import type { WorkspaceMarkdownHtmlInspectionV4 } from '../markdown/workspace-local-link-parser';
import { inspectNativeDocumentLinks, inspectNativeDocumentLinksV4, nativeLinkJsonProof as proof,
  type NativeDocumentLinkInventoryV4 } from '../markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinksV3, inspectOriginalPhysicalLinksV4, inspectOriginalPhysicalHtmlV4,
  workspaceSourceAuthorityStageProof, type OriginalPhysicalLinkInventory, type OriginalPhysicalLinkInventoryV4, type OriginalPhysicalHtmlInventoryV4,
  type WorkspaceSourceAuthorityStage, type PhysicalSourceGap } from '../markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeHtmlSourceEvidenceV4, decodeWorkspaceOperationNativeHtmlSourceEvidenceV4,
  decodeNativeInventoryV4Facts, isNativeSourceFilesystemFingerprint, WorkspaceOperationNativeSourceEvidenceError,
  type WorkspaceOperationNativeHtmlSourceEvidenceV4 } from './workspace-operation-native-source-evidence';

export type PhysicalMarkdownSourceEvidenceV5 = Readonly<Omit<OriginalPhysicalLinkInventoryV4, 'originalBytes'>>;
export type PhysicalHtmlSourceEvidenceV5 = Readonly<Omit<OriginalPhysicalHtmlInventoryV4, 'originalBytes'>>;
export type WorkspaceOperationHtmlOccurrenceV5 = Readonly<{ sourcePath: string; line: number;
  fullyInspected: boolean; explicitLocalTargets: readonly string[] }>;
type SourceLocationV5 = Readonly<{ start: number; end: number; line: number }>;
export type WorkspaceOperationMixedSourceEvidenceV5 = Readonly<{
  evidenceVersion: 5;
  workspaceScope: WorkspaceOperationJobScope;
  namespace: WorkspaceSourceAuthorityStage['namespace'];
  scope: WorkspaceSourceAuthorityStage['scope'];
  /** Original Stage1 gaps remain facts even where ordinary parser4 differs. */
  coverage: WorkspaceSourceAuthorityStage['coverage'];
  observedStageProof: string;
  nativeComponent: WorkspaceOperationNativeHtmlSourceEvidenceV4;
  nativeOrdinarySources4: readonly Readonly<{ documentId: string; legacyInventoryProof: string;
    inventoryProof: string; inventory: NativeDocumentLinkInventoryV4 }>[];
  physicalSources4: readonly PhysicalMarkdownSourceEvidenceV5[];
  physicalHtmlSources4: readonly PhysicalHtmlSourceEvidenceV5[];
  nativeHtmlSourceLocations: readonly Readonly<{ documentId: string; path: string; locations: readonly SourceLocationV5[] }>[];
  physicalHtmlSourceLocations: readonly Readonly<{ path: string; physicalSourceProof: string; locations: readonly SourceLocationV5[] }>[];
  semanticProof: string;
  evidenceProof: string;
}>;
export type WorkspaceOperationMixedSourceSnapshotV5 = Readonly<{
  contractVersion: 5;
  workspaceId: string;
  namespace: WorkspaceOperationMixedSourceEvidenceV5['namespace'];
  documents: readonly NativeDocumentLinkInventoryV4[];
  physicalSources: readonly PhysicalMarkdownSourceEvidenceV5[];
  physicalHtmlSources: readonly PhysicalHtmlSourceEvidenceV5[];
  coverage: WorkspaceSourceAuthorityStage['coverage'];
  htmlOccurrences: readonly WorkspaceOperationHtmlOccurrenceV5[];
  snapshotProof: string;
}>;

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024, MAX_SOURCES = 10_000, MAX_LINKS = 20_000;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 && value < Number.MAX_SAFE_INTEGER && !Object.is(value, -0);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value);
const validPath = (value: unknown): value is string => isCanonicalAdmissionPath(value)
  && typeof value === 'string' && value.length <= 4096 && value.split('/').length <= 33;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function reject(reason: 'invalid' | 'too-large' = 'invalid'): never {
  throw new WorkspaceOperationNativeSourceEvidenceError(reason === 'too-large'
    ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
}
function record(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return reject();
  const keys = Reflect.ownKeys(input);
  if (keys.length < required.length || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) return reject();
  const result: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) { if (required.includes(key)) return reject(); continue; }
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
    result[key] = descriptor.value;
  }
  return result;
}
function list(input: unknown, maximum = MAX_SOURCES): unknown[] {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return reject();
  const size = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (size > maximum) return reject('too-large');
  if (Reflect.ownKeys(input).length !== size + 1) return reject();
  return Array.from({ length: size }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
    return descriptor.value;
  });
}
function capture<T>(value: unknown): T {
  return captureWorkspaceOperationNativePlanData(value, reject, MAX_EVIDENCE_BYTES) as T;
}
function freeze<T>(input: T): T {
  if (typeof input === 'string' && Buffer.from(input).toString('utf8') !== input) return reject();
  if (input && typeof input === 'object') { for (const child of Object.values(input)) freeze(child); Object.freeze(input); }
  return input;
}
function binaryInfo(value: unknown, maximum: number): { value: Uint8Array; size: number } {
  if (!value || types.isProxy(value) || !ArrayBuffer.isView(value)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))
    || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(key => Object.hasOwn(value, key))) return reject();
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const size = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(value) as number;
  const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(value) as ArrayBuffer;
  if (!types.isArrayBuffer(buffer) || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return reject();
  if (size > maximum) return reject('too-large');
  return { value: value as Uint8Array, size };
}
function copyBytes(value: unknown, maximum: number): Uint8Array {
  const input = binaryInfo(value, maximum), bytes = new Uint8Array(input.size);
  Uint8Array.prototype.set.call(bytes, input.value); return bytes;
}
function validatePhysicalGaps(input: unknown, path: string): void {
  for (const value of list(input, MAX_LINKS)) {
    const row = record(value, ['code', 'path'], ['startUtf16', 'htmlTargets']);
    if (!identifier(row.code) || row.path !== path || Object.hasOwn(row, 'startUtf16') && !integer(row.startUtf16)) return reject();
    if (Object.hasOwn(row, 'htmlTargets') && list(row.htmlTargets, MAX_LINKS).some(target => typeof target !== 'string')) return reject();
  }
}
function validateMarkdownHtml(input: WorkspaceMarkdownHtmlInspectionV4, path: string, maximumPosition: number): void {
  record(input, ['parserVersion', 'occurrences']);
  if (input.parserVersion !== 4) return reject();
  let previous = 0;
  for (const raw of list(input.occurrences, MAX_LINKS)) {
    const row = record(raw, ['sourcePath', 'start', 'end', 'raw', 'fullyInspected', 'explicitLocalTargets']);
    if (row.sourcePath !== path || !integer(row.start) || !integer(row.end) || row.start < previous
      || row.end < row.start || row.end > maximumPosition || typeof row.raw !== 'string'
      || !row.raw || row.raw.length !== row.end - row.start || typeof row.fullyInspected !== 'boolean') return reject();
    const targets = list(row.explicitLocalTargets, MAX_LINKS);
    if (targets.some(target => typeof target !== 'string')) return reject();
    if (!isDeepStrictEqual(inspectWorkspaceStaticHtmlLinks(row.raw), { inspectionVersion: 1,
      fullyInspected: row.fullyInspected, explicitLocalTargets: targets })) return reject();
    previous = row.end;
  }
}

function physicalV5Inventory(input: unknown,
  budget: { bytes: number; links: number }): PhysicalMarkdownSourceEvidenceV5 {
  const raw = record(input, ['physicalSourceVersion', 'parserVersion', 'source', 'workspaceId', 'organizationId',
    'path', 'authority', 'physical', 'encoding', 'hasBom', 'lineEndings',
    'frontmatterPrefix', 'metadata', 'links', 'coverage', 'htmlInspection', 'applicability', 'executionReady', 'physicalSourceProof']);
  const value = freeze(captureWorkspaceOperationNativePlanData(raw, reject, 8 * 1024 * 1024)) as PhysicalMarkdownSourceEvidenceV5;
  const v5Integer = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item)
    && item >= 0 && item < Number.MAX_SAFE_INTEGER && !Object.is(item, -0);
  const v5Digest = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item);
  const v5Text = (item: unknown): item is string => typeof item === 'string';
  const v5Identifier = (item: unknown): item is string => v5Text(item) && item.length > 0 && item.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(item);
  const physical = record(value.physical, ['filesystemIdentity', 'byteHash', 'byteLength']);
  const authority = record(value.authority, value.authority.kind === 'unregistered' ? ['kind', 'catalogueProof']
    : ['kind', 'catalogueProof', 'registeredDocumentId', 'lineageId']);
  const metadata = record(value.metadata, ['path', 'aliases', 'tags', 'title', 'hasExplicitTitle', 'headings', 'blockIds']);
  const endings = record(value.lineEndings, ['style', 'lf', 'crlf', 'bareCr']);
  const coverage = record(value.coverage, ['complete', 'gaps']);
  if (value.physicalSourceVersion !== 1 || value.parserVersion !== 4
    || value.source !== 'original-physical-bytes'
    || !v5Identifier(value.workspaceId) || value.organizationId !== null && !v5Identifier(value.organizationId)
    || !isCanonicalAdmissionPath(value.path) || value.path.length > 4096 || value.path.split('/').length > 33
    || !/\.(?:md|markdown)$/iu.test(value.path) || value.encoding !== 'utf8' || typeof value.hasBom !== 'boolean'
    || value.applicability !== 'requires-import-and-rebinding' || value.executionReady !== false
    || !isNativeSourceFilesystemFingerprint(physical.filesystemIdentity) || !v5Digest(physical.byteHash)
    || !v5Integer(physical.byteLength) || physical.byteLength > MAX_INDEXED_MARKDOWN_BYTES
    || Number(String(physical.filesystemIdentity).split(':')[2]) !== physical.byteLength
    || !['unregistered', 'registered-never-initialized'].includes(String(authority.kind)) || !v5Digest(authority.catalogueProof)
    || authority.kind === 'registered-never-initialized' && (!v5Identifier(authority.registeredDocumentId)
      || authority.lineageId !== null && !v5Identifier(authority.lineageId))
    || typeof coverage.complete !== 'boolean' || !Array.isArray(coverage.gaps) || coverage.complete !== (coverage.gaps.length === 0)
    || !v5Text(value.frontmatterPrefix) || Buffer.byteLength(value.frontmatterPrefix) > physical.byteLength
    || !['none', 'lf', 'crlf', 'mixed', 'bare-cr'].includes(String(endings.style))
    || ![endings.lf, endings.crlf, endings.bareCr].every(v5Integer)
    || Number(endings.lf) + Number(endings.crlf) * 2 + Number(endings.bareCr) > physical.byteLength
    || metadata.path !== value.path || !v5Text(metadata.title) || typeof metadata.hasExplicitTitle !== 'boolean'
    || ![metadata.aliases, metadata.tags, metadata.blockIds].every(items => Array.isArray(items) && items.every(v5Text))
    || !Array.isArray(metadata.headings) || list(metadata.headings, MAX_LINKS).length !== metadata.headings.length
    || [metadata.aliases, metadata.tags, metadata.blockIds].some(items => list(items, MAX_LINKS).length !== (items as unknown[]).length)
    || !Array.isArray(value.links) || value.links.length > budget.links) return reject();
  const expectedStyle = endings.bareCr ? 'bare-cr' : endings.lf && endings.crlf ? 'mixed' : endings.lf ? 'lf' : endings.crlf ? 'crlf' : 'none';
  if (endings.style !== expectedStyle) return reject();
  for (const heading of metadata.headings) {
    const row = record(heading, ['depth', 'text']);
    if (!v5Integer(row.depth) || row.depth < 1 || row.depth > 6 || !v5Text(row.text)) return reject();
  }
  budget.links -= value.links.length;
  const ids = new Set<string>();
  for (const link of value.links) {
    record(link, ['alias', 'embed', 'end', 'fragment', 'kind', 'raw', 'sourcePath', 'start', 'syntax',
      'targetEnd', 'targetLiteral', 'targetPathText', 'targetStart', 'workspaceRootRelative', 'physicalLinkId', 'syntaxRange', 'targetRange']);
    for (const range of [link.syntaxRange, link.targetRange]) {
      record(range, ['startUtf16', 'endUtf16', 'startUtf8Byte', 'endUtf8Byte']);
      if (![range.startUtf16, range.endUtf16, range.startUtf8Byte, range.endUtf8Byte].every(v5Integer)
        || range.startUtf16 > range.endUtf16 || range.startUtf8Byte > range.endUtf8Byte
        || range.endUtf16 > physical.byteLength || range.endUtf8Byte > physical.byteLength) return reject();
    }
    if (!['wiki', 'markdown'].includes(link.kind)
      || !['inline-link', 'inline-image', 'reference-link', 'reference-image', 'reference-definition', 'wiki-link', 'wiki-embed'].includes(link.syntax)
      || link.sourcePath !== value.path || !v5Text(link.raw) || !v5Text(link.targetLiteral) || !v5Text(link.targetPathText)
      || link.alias !== null && !v5Text(link.alias) || link.fragment !== null && !v5Text(link.fragment)
      || typeof link.embed !== 'boolean' || typeof link.workspaceRootRelative !== 'boolean'
      || link.start !== link.syntaxRange.startUtf16 || link.end !== link.syntaxRange.endUtf16
      || link.targetStart !== link.targetRange.startUtf16 || link.targetEnd !== link.targetRange.endUtf16
      || link.start > link.targetStart || link.targetEnd > link.end
      || link.syntaxRange.startUtf8Byte > link.targetRange.startUtf8Byte || link.targetRange.endUtf8Byte > link.syntaxRange.endUtf8Byte
      || link.end - link.start !== link.raw.length || link.targetEnd - link.targetStart !== link.targetLiteral.length
      || link.raw.slice(link.targetStart - link.start, link.targetEnd - link.start) !== link.targetLiteral
      || link.syntaxRange.endUtf8Byte - link.syntaxRange.startUtf8Byte !== Buffer.byteLength(link.raw)
      || link.targetRange.endUtf8Byte - link.targetRange.startUtf8Byte !== Buffer.byteLength(link.targetLiteral)
      || ids.has(link.physicalLinkId) || link.physicalLinkId !== `physical:${proof({ workspaceId: value.workspaceId,
        path: value.path, authority: value.authority, physical: value.physical,
        syntaxRange: link.syntaxRange, targetRange: link.targetRange, raw: link.raw })}`) return reject();
    ids.add(link.physicalLinkId);
  }
  const { physicalSourceProof, ...body } = value;
  if (!v5Digest(physicalSourceProof) || proof({ ...body, observedOriginalByteHash: physical.byteHash }) !== physicalSourceProof) return reject();
  validatePhysicalGaps(value.coverage.gaps, value.path);
  validateMarkdownHtml(value.htmlInspection, value.path, physical.byteLength);
  return value;
}

function physicalHtmlInventory(input: unknown): PhysicalHtmlSourceEvidenceV5 {
  const value = capture<PhysicalHtmlSourceEvidenceV5>(record(input, ['htmlSourceVersion', 'source', 'workspaceId', 'organizationId',
    'path', 'authority', 'physical', 'encoding', 'hasBom', 'lineEndings', 'htmlInspection', 'applicability', 'executionReady', 'htmlSourceProof']));
  const physical = record(value.physical, ['filesystemIdentity', 'byteHash', 'byteLength']);
  const authority = record(value.authority, value.authority.kind === 'unregistered' ? ['kind', 'catalogueProof']
    : ['kind', 'catalogueProof', 'registeredDocumentId', 'lineageId']);
  const endings = record(value.lineEndings, ['style', 'lf', 'crlf', 'bareCr']);
  const inspection = record(value.htmlInspection, ['inspectionVersion', 'fullyInspected', 'explicitLocalTargets']);
  if (value.htmlSourceVersion !== 4 || value.source !== 'original-physical-html-bytes' || !identifier(value.workspaceId)
    || value.organizationId !== null && !identifier(value.organizationId) || !validPath(value.path) || !/\.html?$/iu.test(value.path)
    || value.encoding !== 'utf8' || typeof value.hasBom !== 'boolean' || value.executionReady !== false
    || value.applicability !== 'requires-operation-assessment' || !isNativeSourceFilesystemFingerprint(physical.filesystemIdentity)
    || !digest(physical.byteHash) || !integer(physical.byteLength) || physical.byteLength > MAX_INDEXED_MARKDOWN_BYTES
    || Number(String(physical.filesystemIdentity).split(':')[2]) !== physical.byteLength
    || !['unregistered', 'registered-never-initialized'].includes(String(authority.kind)) || !digest(authority.catalogueProof)
    || authority.kind === 'registered-never-initialized' && (!identifier(authority.registeredDocumentId)
      || authority.lineageId !== null && !identifier(authority.lineageId))
    || ![endings.lf, endings.crlf, endings.bareCr].every(integer)
    || Number(endings.lf) + Number(endings.crlf) * 2 + Number(endings.bareCr) > physical.byteLength
    || endings.style !== (endings.bareCr ? 'bare-cr' : endings.lf && endings.crlf ? 'mixed' : endings.lf ? 'lf' : endings.crlf ? 'crlf' : 'none')
    || inspection.inspectionVersion !== 1 || typeof inspection.fullyInspected !== 'boolean'
    || list(inspection.explicitLocalTargets, MAX_LINKS).some(target => typeof target !== 'string')) return reject();
  const { htmlSourceProof, ...body } = value;
  if (!digest(htmlSourceProof) || proof({ ...body, observedOriginalByteHash: physical.byteHash }) !== htmlSourceProof) return reject();
  // No original HTML text is persisted. This historical inspection is a bound
  // fact, never AST-completeness proof; Current replays the actual original bytes.
  return value;
}

function sourceLocations(text: string, occurrences: WorkspaceMarkdownHtmlInspectionV4['occurrences']): SourceLocationV5[] {
  let cursor = 0, line = 1;
  return occurrences.map(occurrence => {
    while (cursor < occurrence.start) {
      if (text[cursor] === '\r') { line++; cursor += text[cursor + 1] === '\n' ? 2 : 1; }
      else { if (text[cursor] === '\n') line++; cursor++; }
    }
    if (text.slice(occurrence.start, occurrence.end) !== occurrence.raw) return reject();
    return { start: occurrence.start, end: occurrence.end, line };
  });
}
function validateLocations(input: unknown, occurrences: WorkspaceMarkdownHtmlInspectionV4['occurrences']): void {
  const values = list(input, MAX_LINKS);
  if (values.length !== occurrences.length) return reject();
  let previousLine = 1;
  for (let index = 0; index < values.length; index++) {
    const row = record(values[index], ['start', 'end', 'line']), occurrence = occurrences[index];
    if (row.start !== occurrence.start || row.end !== occurrence.end || !integer(row.line) || row.line < previousLine
      || row.line > occurrence.start + 1) return reject();
    previousLine = row.line;
  }
}
function coverageGaps(sources: WorkspaceSourceAuthorityStage['sources']): PhysicalSourceGap[] {
  return sources.flatMap(source => source.kind === 'native'
    ? source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) : source.inventory.coverage.gaps);
}
function gapMultiset(gaps: readonly PhysicalSourceGap[]): string[] { return gaps.map(proof).sort(); }

/** All binary budgets are charged BEFORE any clone, parse or hash. Capture
 * accesses own plain DATA descriptors and actual typed-array slots exclusively. */
function captureObservation(input: unknown) {
  const raw = record(input, ['stage', 'nativeBindings', 'privateNativeStates', 'privateCatalogue']);
  const stageRow = record(raw.stage, ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace',
    'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof']);
  const rawSources = list(stageRow.sources), rawStates = list(raw.privateNativeStates);
  let remaining = 32 * 1024 * 1024, remainingLinks = MAX_LINKS;
  const charge = (value: unknown, maximum: number) => { remaining -= binaryInfo(value, maximum).size;
    if (remaining < 0) return reject('too-large'); };
  for (const state of rawStates) {
    if (!state || typeof state !== 'object' || types.isProxy(state) || Object.getPrototypeOf(state) !== Object.prototype) return reject();
    for (const [field, maximum] of [['yjsState', 16 * 1024 * 1024], ['stateVector', 1024 * 1024]] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(state, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
      charge(descriptor.value, maximum);
    }
  }
  for (const inputSource of rawSources) {
    const source = record(inputSource, ['kind', 'inventory']);
    if (!source.inventory || typeof source.inventory !== 'object' || types.isProxy(source.inventory)
      || Object.getPrototypeOf(source.inventory) !== Object.prototype) return reject();
    const field = (name: string) => { const descriptor = Object.getOwnPropertyDescriptor(source.inventory, name);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject(); return descriptor.value; };
    remainingLinks -= list(field('links'), MAX_LINKS).length;
    if (remainingLinks < 0) return reject('too-large');
    if (source.kind === 'physical') charge(field('originalBytes'), MAX_INDEXED_MARKDOWN_BYTES);
    else if (source.kind !== 'native') return reject();
  }
  const stateRows = rawStates.map(inputState => record(inputState, ['documentId', 'workspaceId', 'organizationId', 'path', 'representation',
    'lifecycleGeneration', 'schemaVersion', 'yjsState', 'stateVector', 'documentSequence', 'persistedAt', 'checkpointedAt',
    'checkpointSequence', 'canonicalHash', 'serializedHash', 'newlineStyle', 'hasBom', 'degraded', 'status'], ['projectionError', 'projectionFinalized']));
  const stateHeaders = stateRows.map(row => {
    const { yjsState: _binary, stateVector: _vector, ...header } = row;
    if (header.projectionError === undefined) delete header.projectionError;
    if (header.projectionFinalized === undefined) delete header.projectionFinalized;
    return header;
  });
  const sourceRows = rawSources.map(inputSource => record(inputSource, ['kind', 'inventory']));
  const physicalRows = sourceRows.map(row => row.kind === 'physical' ? record(row.inventory, ['physicalSourceVersion', 'parserVersion',
    'source', 'workspaceId', 'organizationId', 'path', 'authority', 'physical', 'originalBytes', 'encoding', 'hasBom',
    'lineEndings', 'frontmatterPrefix', 'metadata', 'links', 'coverage', 'applicability', 'executionReady', 'physicalSourceProof']) : null);
  const sourceHeaders = sourceRows.map((row, index) => {
    const physical = physicalRows[index];
    if (!physical) return row;
    const { originalBytes: _bytes, ...inventory } = physical; return { kind: 'physical', inventory };
  });
  const { sources: _sources, ...stageHeader } = stageRow;
  type SourceHeader = Extract<WorkspaceSourceAuthorityStage['sources'][number], { kind: 'native' }>
    | { kind: 'physical'; inventory: Omit<OriginalPhysicalLinkInventory, 'originalBytes'> };
  // One aggregate JSON budget before cloning any private payload or parsing.
  const facts = capture<{ stage: Omit<WorkspaceSourceAuthorityStage, 'sources'>;
    nativeBindings: WorkspaceLinkSourceAuthorityObservation['nativeBindings'];
    privateCatalogue: NonNullable<WorkspaceLinkSourceAuthorityObservation['privateCatalogue']>;
    states: Omit<PersistedCollaborationState, 'yjsState' | 'stateVector'>[]; sources: SourceHeader[] }>({
    stage: stageHeader, nativeBindings: raw.nativeBindings, privateCatalogue: raw.privateCatalogue, states: stateHeaders, sources: sourceHeaders });
  const states: PersistedCollaborationState[] = facts.states.map((state, index) => ({ ...state,
    yjsState: copyBytes(stateRows[index].yjsState, 16 * 1024 * 1024), stateVector: copyBytes(stateRows[index].stateVector, 1024 * 1024) }));
  const sources: WorkspaceSourceAuthorityStage['sources'] = [];
  for (const [index, source] of facts.sources.entries()) {
    if (source.kind === 'native') { sources.push(source); continue; }
    const inventory = source.inventory;
    // Base read profile is fixed parser3 even for an empty physical set. Never
    // reinterpret old parser2 evidence or retag the Stage1/native2 observations.
    if (inventory.parserVersion !== 3 || !/\.(?:md|markdown|html?)$/iu.test(inventory.path)) return reject();
    const bytes = copyBytes(physicalRows[index]!.originalBytes, MAX_INDEXED_MARKDOWN_BYTES);
    const parsed = inspectOriginalPhysicalLinksV3({ workspaceId: inventory.workspaceId, organizationId: inventory.organizationId,
      path: inventory.path, authority: inventory.authority, bytes, filesystemIdentity: inventory.physical.filesystemIdentity });
    const { originalBytes: _bytes, ...actual } = parsed;
    if (!isDeepStrictEqual(actual, inventory)) return reject();
    sources.push({ kind: 'physical', inventory: parsed });
  }
  const stage: WorkspaceSourceAuthorityStage = { ...facts.stage, sources };
  if (stage.stageVersion !== 1 || stage.executionReady !== false || stage.coverage.complete !== (stage.coverage.gaps.length === 0)
    || !isDeepStrictEqual(gapMultiset(stage.coverage.gaps), gapMultiset(coverageGaps(stage.sources)))
    || stage.readiness !== (stage.coverage.gaps.length ? 'blocked' : sources.some(source => source.kind === 'physical')
      ? 'requires-import-and-rebinding' : 'native-coordinator-required')
    || workspaceSourceAuthorityStageProof(stage) !== stage.stageProof) return reject();
  return { stage, nativeBindings: facts.nativeBindings, privateNativeStates: states, privateCatalogue: facts.privateCatalogue };
}

function nativeComponent(scope: WorkspaceOperationJobScope, observation: ReturnType<typeof captureObservation>) {
  const physicalPaths = new Set(observation.stage.sources.flatMap(source => source.kind === 'physical' ? [source.inventory.path] : []));
  const sources = observation.stage.sources.filter((source): source is Extract<WorkspaceSourceAuthorityStage['sources'][number], { kind: 'native' }> => source.kind === 'native');
  const gaps = coverageGaps(sources);
  const body: WorkspaceSourceAuthorityStage = { ...observation.stage, sources,
    namespace: observation.stage.namespace.filter(entry => !physicalPaths.has(entry.path)),
    scope: { ...observation.stage.scope, excludedPaths: [...new Set([...observation.stage.scope.excludedPaths, ...physicalPaths])].sort() },
    coverage: { complete: !gaps.length, gaps }, readiness: gaps.length ? 'blocked' : 'native-coordinator-required' };
  body.stageProof = workspaceSourceAuthorityStageProof(body);
  return captureWorkspaceOperationNativeHtmlSourceEvidenceV4(scope, { ...observation, stage: body });
}
function semantic(value: Omit<WorkspaceOperationMixedSourceEvidenceV5, 'semanticProof' | 'evidenceProof'>) {
  const normalizePhysical = (source: PhysicalMarkdownSourceEvidenceV5 | PhysicalHtmlSourceEvidenceV5) => {
    const { authority, ...body } = source;
    if ('links' in body) {
      const { physicalSourceProof: _proof, links, ...rest } = body;
      return { ...rest, authority: { ...authority, catalogueProof: value.nativeComponent.semanticCatalogueProof },
        links: links.map(({ physicalLinkId: _id, ...link }) => link) };
    }
    const { htmlSourceProof: _proof, ...rest } = body;
    return { ...rest, authority: { ...authority, catalogueProof: value.nativeComponent.semanticCatalogueProof } };
  };
  return { semanticVersion: 5, workspaceScope: value.workspaceScope, scope: value.scope, coverage: value.coverage,
    nativeComponent: value.nativeComponent.semanticProof, nativeOrdinarySources4: value.nativeOrdinarySources4,
    physicalSources4: value.physicalSources4.map(normalizePhysical), physicalHtmlSources4: value.physicalHtmlSources4.map(normalizePhysical),
    nativeHtmlSourceLocations: value.nativeHtmlSourceLocations,
    physicalHtmlSourceLocations: value.physicalHtmlSourceLocations.map(({ path, locations }) => ({ path, locations })) };
}

function validateNamespace(value: WorkspaceOperationMixedSourceEvidenceV5): void {
  const component = value.nativeComponent, physical = [...value.physicalSources4, ...value.physicalHtmlSources4];
  const physicalByPath = new Map(physical.map(source => [source.path, source]));
  const documentIds = new Set(component.nativeBindings.map(binding => binding.expected.documentId));
  if (physicalByPath.size !== physical.length || physical.length + component.stage.sources.length > MAX_SOURCES) return reject();
  for (const source of physical) {
    if (source.workspaceId !== value.workspaceScope.workspaceId || source.organizationId !== value.workspaceScope.organizationId
      || source.authority.catalogueProof !== component.stage.catalogueProof) return reject();
    if (source.authority.kind === 'registered-never-initialized') {
      if (documentIds.has(source.authority.registeredDocumentId)) return reject();
      documentIds.add(source.authority.registeredDocumentId);
    }
  }
  const paths = new Map<string, WorkspaceOperationMixedSourceEvidenceV5['namespace'][number]>();
  for (const raw of list(value.namespace)) {
    const entry = raw as WorkspaceOperationMixedSourceEvidenceV5['namespace'][number];
    if (!validPath(entry.path) || paths.has(entry.path) || value.scope.excludedPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) return reject();
    paths.set(entry.path, entry);
    const source = physicalByPath.get(entry.path);
    if (!source) continue;
    record(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity']);
    if (entry.workspaceId !== value.workspaceScope.workspaceId || entry.kind !== 'file' || entry.documentId !== null
      || entry.lifecycleGeneration !== null || entry.identity !== source.physical.filesystemIdentity
      || entry.filesystemIdentity !== source.physical.filesystemIdentity) return reject();
  }
  if (physical.some(source => !paths.has(source.path))
    || !isDeepStrictEqual(value.namespace.filter(entry => !physicalByPath.has(entry.path)), component.stage.namespace)
    || !isDeepStrictEqual(component.stage.scope.excludedPaths, [...new Set([...value.scope.excludedPaths, ...physicalByPath.keys()])].sort())) return reject();
  for (const entry of value.namespace) {
    const parts = entry.path.split('/'); parts.pop();
    while (parts.length) { if (paths.get(parts.join('/'))?.kind !== 'directory') return reject(); parts.pop(); }
  }
}
function validateHtmlBudgets(value: WorkspaceOperationMixedSourceEvidenceV5): void {
  let occurrences = 0, targets = 0;
  const charge = (count: number, countTargets: number) => {
    occurrences += count; targets += countTargets;
    if (occurrences > MAX_LINKS || targets > MAX_LINKS) return reject('too-large');
  };
  for (const source of value.nativeComponent.htmlSources) for (const occurrence of source.inspection.occurrences) charge(1, occurrence.explicitLocalTargets.length);
  for (const source of value.physicalSources4) for (const occurrence of source.htmlInspection.occurrences) charge(1, occurrence.explicitLocalTargets.length);
  for (const source of value.physicalHtmlSources4) charge(1, source.htmlInspection.explicitLocalTargets.length);
}
type HistoricalEvidenceValidation = Readonly<{ usedRichLinkAttributeKeys: readonly string[] }>;
const historicalEvidenceValidations = new WeakMap<object, HistoricalEvidenceValidation>();

/** Only exact immutable PlainJSON references may share historical validation.
 * The complete capture/freeze and all its budgets run BEFORE this predicate. */
function isRecursivelyFrozenEvidence(input: unknown): input is object {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return true;
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)
      || !Object.isFrozen(value)) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
      Object.hasOwn(descriptor, 'value') && visit(descriptor.value));
  };
  return !!input && typeof input === 'object' && visit(input);
}
function usedRichLinkAttributeKeys(value: WorkspaceOperationMixedSourceEvidenceV5): readonly string[] {
  const keys = new Set<string>();
  const inventories = [
    ...value.nativeComponent.stage.sources.map(source => source.inventory),
    ...value.nativeOrdinarySources4.map(source => source.inventory),
  ];
  for (const inventory of inventories) for (const link of inventory.links) {
    if (link.ref.kind === 'link-mark') for (const key of Object.keys(link.ref.expected)) keys.add(key);
  }
  return [...keys].sort();
}
/** Historical Rich inventories depend on the live inspection grammar's
 * lifetime and accepted attribute names. A miss/error uses the original cold
 * decoder so its exact error category remains in force. */
function historicalRichLinkAttributesCurrent(validation: HistoricalEvidenceValidation): boolean {
  if (!validation.usedRichLinkAttributeKeys.length) return true;
  try {
    const current = Object.keys(getNativeInspectionSchema().marks.link.spec.attrs ?? {});
    return validation.usedRichLinkAttributeKeys.every(key => current.includes(key));
  } catch { return false; }
}

function inspectEvidence(input: unknown): WorkspaceOperationMixedSourceEvidenceV5 {
  const value = freeze(capture<WorkspaceOperationMixedSourceEvidenceV5>(input));
  const cacheable = !!input && typeof input === 'object'
    && (historicalEvidenceValidations.has(input) || isRecursivelyFrozenEvidence(input));
  const cached = cacheable ? historicalEvidenceValidations.get(input) : undefined;
  if (cached && historicalRichLinkAttributesCurrent(cached)) {
    historicalEvidenceValidations.set(value, cached);
    return value;
  }
  record(value, ['evidenceVersion', 'workspaceScope', 'namespace', 'scope', 'coverage', 'observedStageProof', 'nativeComponent',
    'nativeOrdinarySources4', 'physicalSources4', 'physicalHtmlSources4', 'nativeHtmlSourceLocations', 'physicalHtmlSourceLocations', 'semanticProof', 'evidenceProof']);
  const component = decodeWorkspaceOperationNativeHtmlSourceEvidenceV4(value.nativeComponent);
  if (value.evidenceVersion !== 5 || !isDeepStrictEqual(value.workspaceScope, component.workspaceScope) || !digest(value.observedStageProof)) return reject();
  record(value.scope, ['kind', 'excludedPaths']); record(value.coverage, ['complete', 'gaps']);
  if (value.scope.kind !== 'visible-workspace' || list(value.scope.excludedPaths).some(path => !validPath(path))
    || new Set(value.scope.excludedPaths).size !== value.scope.excludedPaths.length || typeof value.coverage.complete !== 'boolean'
    || value.coverage.complete !== (list(value.coverage.gaps, MAX_LINKS).length === 0)) return reject();
  for (const gap of value.coverage.gaps) {
    record(gap, ['code', 'path'], ['startUtf16', 'htmlTargets']);
    if (!identifier(gap.code) || !validPath(gap.path) || gap.startUtf16 !== undefined && !integer(gap.startUtf16)
      || gap.htmlTargets !== undefined && list(gap.htmlTargets, MAX_LINKS).some(target => typeof target !== 'string')) return reject();
  }
  // An enclosing rehash cannot remove an independently retained native2 gap.
  // Old physical3 AST facts are not present historically: only actual Current
  // reinspection can prove those and their multiplicity against the original.
  const originalGapCounts = new Map<string, number>();
  for (const gap of value.coverage.gaps) { const key = proof(gap); originalGapCounts.set(key, (originalGapCounts.get(key) ?? 0) + 1); }
  for (const gap of component.stage.coverage.gaps) {
    const key = proof(gap), count = originalGapCounts.get(key) ?? 0;
    if (!count) return reject(); originalGapCounts.set(key, count - 1);
  }
  const ordinary = list(value.nativeOrdinarySources4), legacySources = new Map(component.stage.sources.map(source => [source.inventory.document.documentId, source.inventory]));
  if (ordinary.length !== component.nativeBindings.length) return reject();
  let remainingLinks = MAX_LINKS, remainingGaps = MAX_LINKS;
  const seen = new Set<string>();
  for (const raw of ordinary) {
    const source = raw as WorkspaceOperationMixedSourceEvidenceV5['nativeOrdinarySources4'][number];
    record(source, ['documentId', 'legacyInventoryProof', 'inventoryProof', 'inventory']);
    const actual = decodeNativeInventoryV4Facts(source.inventory), legacy = legacySources.get(source.documentId);
    if (seen.has(source.documentId) || !legacy || actual.document.documentId !== source.documentId
      || !isDeepStrictEqual(actual.document, legacy.document) || !isDeepStrictEqual(actual.version, legacy.version)
      || source.legacyInventoryProof !== proof(legacy) || source.inventoryProof !== proof(actual)) return reject();
    seen.add(source.documentId); remainingLinks -= actual.links.length; remainingGaps -= actual.coverage.gaps.length;
    if (remainingLinks < 0 || remainingGaps < 0) return reject('too-large');
  }
  if (!isDeepStrictEqual(value.nativeOrdinarySources4.map(source => source.documentId), component.nativeBindings.map(binding => binding.expected.documentId))) return reject();
  if (list(value.physicalSources4).length + list(value.physicalHtmlSources4).length + component.nativeBindings.length > MAX_SOURCES) return reject('too-large');
  const budget = { bytes: 0, links: remainingLinks };
  let physicalBytes = 0;
  for (const raw of list(value.physicalSources4)) { const source = physicalV5Inventory(raw, budget);
    physicalBytes += source.physical.byteLength; remainingGaps -= source.coverage.gaps.length;
    if (remainingGaps < 0) return reject('too-large'); }
  for (const raw of list(value.physicalHtmlSources4)) physicalBytes += physicalHtmlInventory(raw).physical.byteLength;
  if (physicalBytes > 32 * 1024 * 1024) return reject('too-large');
  for (const sources of [value.physicalSources4, value.physicalHtmlSources4]) {
    if (!isDeepStrictEqual(sources.map(source => source.path), sources.map(source => source.path).sort((a, b) => a.localeCompare(b)))) return reject();
  }
  if (list(value.nativeHtmlSourceLocations).length !== component.htmlSources.length
    || list(value.physicalHtmlSourceLocations).length !== value.physicalSources4.length) return reject();
  for (let index = 0; index < component.htmlSources.length; index++) {
    const row = value.nativeHtmlSourceLocations[index], source = component.htmlSources[index];
    record(row, ['documentId', 'path', 'locations']);
    if (row.documentId !== source.documentId || row.path !== source.path) return reject();
    validateLocations(row.locations, source.inspection.occurrences);
  }
  for (let index = 0; index < value.physicalSources4.length; index++) {
    const row = value.physicalHtmlSourceLocations[index], source = value.physicalSources4[index];
    record(row, ['path', 'physicalSourceProof', 'locations']);
    if (row.path !== source.path || row.physicalSourceProof !== source.physicalSourceProof) return reject();
    validateLocations(row.locations, source.htmlInspection.occurrences);
  }
  validateHtmlBudgets(value); validateNamespace(value);
  const { evidenceProof, ...body } = value;
  if (value.semanticProof !== proof(semantic(value)) || evidenceProof !== proof(body)) return reject();
  const validation = freeze({ usedRichLinkAttributeKeys: usedRichLinkAttributeKeys(value) });
  if (cacheable) historicalEvidenceValidations.set(input, validation);
  historicalEvidenceValidations.set(value, validation);
  return value;
}

/** Version5 is a same-original-byte fact contract. It does not import physical
 * sources, discard old gaps, serialize Rich Markdown, or grant write authority. */
export function captureWorkspaceOperationMixedSourceEvidenceV5(scope: WorkspaceOperationJobScope,
  input: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationMixedSourceEvidenceV5 {
  try {
    const observation = captureObservation(input), component = nativeComponent(scope, observation);
    if (observation.stage.workspaceId !== component.workspaceScope.workspaceId
      || observation.stage.organizationId !== component.workspaceScope.organizationId) return reject();
    const witness = captureWorkspaceOperationNativeCatalogueWitness(observation.privateCatalogue, component.workspaceScope,
      observation.stage.catalogueProof!, component.nativeBindings, reject);
    const states = new Map(observation.privateNativeStates.map(state => [state.documentId, state]));
    const originals = new Map(component.stage.sources.map(source => [source.inventory.document.documentId, source.inventory]));
    const nativeOrdinarySources4: WorkspaceOperationMixedSourceEvidenceV5['nativeOrdinarySources4'][number][] = [];
    const nativeHtmlSourceLocations: WorkspaceOperationMixedSourceEvidenceV5['nativeHtmlSourceLocations'][number][] = [];
    let remainingLinks = MAX_LINKS, remainingGaps = MAX_LINKS, remainingOccurrences = MAX_LINKS, remainingTargets = MAX_LINKS;
    const chargeInspection = (inspection: WorkspaceMarkdownHtmlInspectionV4) => {
      remainingOccurrences -= inspection.occurrences.length;
      remainingTargets -= inspection.occurrences.reduce((count, occurrence) => count + occurrence.explicitLocalTargets.length, 0);
      if (remainingOccurrences < 0 || remainingTargets < 0) return reject('too-large');
    };
    for (const [index, binding] of component.nativeBindings.entries()) {
      const state = states.get(binding.expected.documentId), original = originals.get(binding.expected.documentId);
      const html = component.htmlSources[index];
      if (!state || !original || original.document.documentId !== binding.expected.documentId
        || sha(state.yjsState) !== binding.expected.binaryHash || sha(state.stateVector) !== binding.expected.vectorHash) return reject();
      const paired = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
        assertNativeDocumentSchema(doc, state.representation, getNativeInspectionSchema());
        const legacy = inspectNativeDocumentLinks(doc, snapshot), inventory = inspectNativeDocumentLinksV4(doc, snapshot);
        if (!isDeepStrictEqual(legacy, original) || proof(legacy) !== binding.inventoryProof
          || !isDeepStrictEqual(inventory.document, legacy.document) || !isDeepStrictEqual(inventory.version, legacy.version)) return reject();
        return { inventory, locations: snapshot.content.kind === 'plain_text'
          ? sourceLocations(snapshot.content.text, html.inspection.occurrences) : [] };
      });
      remainingLinks -= paired.inventory.links.length; remainingGaps -= paired.inventory.coverage.gaps.length; chargeInspection(html.inspection);
      if (remainingLinks < 0 || remainingGaps < 0) return reject('too-large');
      nativeOrdinarySources4.push({ documentId: state.documentId, legacyInventoryProof: binding.inventoryProof,
        inventoryProof: proof(paired.inventory), inventory: paired.inventory });
      nativeHtmlSourceLocations.push({ documentId: state.documentId, path: state.path, locations: paired.locations });
    }
    const physicalSources4: PhysicalMarkdownSourceEvidenceV5[] = [], physicalHtmlSources4: PhysicalHtmlSourceEvidenceV5[] = [];
    const physicalHtmlSourceLocations: WorkspaceOperationMixedSourceEvidenceV5['physicalHtmlSourceLocations'][number][] = [];
    const catalogueByPath = new Map(witness.entries.map(entry => [entry.path, entry]));
    const physicalPaths = new Set<string>();
    const initialized = new Set(component.nativeBindings.map(binding => binding.expected.documentId));
    for (const source of observation.stage.sources) {
      if (source.kind !== 'physical') continue;
      const inventory = source.inventory, authority = inventory.authority, entry = catalogueByPath.get(inventory.path);
      if (physicalPaths.has(inventory.path) || authority.catalogueProof !== observation.stage.catalogueProof
        || authority.kind === 'unregistered' && entry || authority.kind === 'registered-never-initialized'
        && (!entry || entry.authority !== 'pristine' || entry.id !== authority.registeredDocumentId || entry.lineage_id !== authority.lineageId)) return reject();
      physicalPaths.add(inventory.path);
      const options = { workspaceId: inventory.workspaceId, organizationId: inventory.organizationId, path: inventory.path,
        authority, filesystemIdentity: inventory.physical.filesystemIdentity, bytes: inventory.originalBytes };
      if (/\.html?$/iu.test(inventory.path)) {
        const { originalBytes: _bytes, ...facts } = inspectOriginalPhysicalHtmlV4(options);
        remainingOccurrences--; remainingTargets -= facts.htmlInspection.explicitLocalTargets.length;
        if (remainingOccurrences < 0 || remainingTargets < 0) return reject('too-large');
        physicalHtmlSources4.push(facts);
      } else {
        const { originalBytes: bytes, ...facts } = inspectOriginalPhysicalLinksV4({ ...options, maxLinks: remainingLinks });
        if (facts.coverage.gaps.some(gap => gap.code === 'source-link-limit')) return reject('too-large');
        remainingLinks -= facts.links.length; remainingGaps -= facts.coverage.gaps.length; chargeInspection(facts.htmlInspection);
        if (remainingLinks < 0 || remainingGaps < 0) return reject('too-large');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        physicalSources4.push(facts);
        physicalHtmlSourceLocations.push({ path: facts.path, physicalSourceProof: facts.physicalSourceProof,
          locations: sourceLocations(text, facts.htmlInspection.occurrences) });
      }
    }
    for (const entry of witness.entries) {
      if (entry.authority === 'initialized' && !initialized.has(entry.id)) return reject();
      if (/\.(?:md|markdown|html?)$/iu.test(entry.path) && entry.authority !== 'initialized'
        && (entry.authority !== 'pristine' || !physicalPaths.has(entry.path))) return reject();
    }
    physicalSources4.sort((a, b) => a.path.localeCompare(b.path));
    physicalHtmlSources4.sort((a, b) => a.path.localeCompare(b.path));
    physicalHtmlSourceLocations.sort((a, b) => a.path.localeCompare(b.path));
    const facts = { evidenceVersion: 5 as const, workspaceScope: component.workspaceScope, namespace: observation.stage.namespace,
      scope: observation.stage.scope, coverage: observation.stage.coverage, observedStageProof: observation.stage.stageProof,
      nativeComponent: component, nativeOrdinarySources4, physicalSources4, physicalHtmlSources4,
      nativeHtmlSourceLocations, physicalHtmlSourceLocations };
    const body = { ...facts, semanticProof: proof(semantic(facts)) };
    return inspectEvidence({ ...body, evidenceProof: proof(body) });
  } catch (error) {
    if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error;
    return reject(error instanceof RangeError ? 'too-large' : 'invalid');
  }
}
/** Shape/proof validation of historical facts only. No original bytes or live
 * catalogue/ACL/admission authority can be reconstructed from this DTO. */
export function decodeWorkspaceOperationMixedSourceEvidenceV5(input: unknown): WorkspaceOperationMixedSourceEvidenceV5 {
  try { return inspectEvidence(input); }
  catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return reject(error instanceof RangeError ? 'too-large' : 'invalid'); }
}
/** Fresh complete observation repeats original2 + ordinary4 + HTML4 over actual
 * same bytes. Raw catalogue/projection clocks are normalized only by their
 * existing V4 semantic policy, never by substituting a declared matching hash. */
export function assertWorkspaceOperationMixedSourceEvidenceV5Current(expected: WorkspaceOperationMixedSourceEvidenceV5,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationMixedSourceEvidenceV5(expected), current = captureWorkspaceOperationMixedSourceEvidenceV5(scope, observation);
  if (original.semanticProof !== current.semanticProof) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
}
/** Server-side derived inventory binding, never a second freely persisted copy
 * of expected identity, registry, lineage, byte profile, or write authority. */
export function workspaceOperationMixedSourceBindingsV5(input: WorkspaceOperationMixedSourceEvidenceV5): readonly WorkspaceNativeSourceBinding[] {
  const value = decodeWorkspaceOperationMixedSourceEvidenceV5(input);
  return freeze(value.nativeComponent.nativeBindings.map((binding, index) => ({ ...binding,
    inventoryProof: value.nativeOrdinarySources4[index].inventoryProof })));
}
/** Normalized assessment facts preserve ALL sources/occurrences, including
 * unknown syntax and fully inspected empty target lists. No raw text is invented. */
function htmlOccurrences(value: WorkspaceOperationMixedSourceEvidenceV5): readonly WorkspaceOperationHtmlOccurrenceV5[] {
  const result: WorkspaceOperationHtmlOccurrenceV5[] = [];
  for (const [index, source] of value.nativeComponent.htmlSources.entries()) {
    for (const [offset, occurrence] of source.inspection.occurrences.entries()) result.push({ sourcePath: source.path,
      line: value.nativeHtmlSourceLocations[index].locations[offset].line, fullyInspected: occurrence.fullyInspected,
      explicitLocalTargets: occurrence.explicitLocalTargets });
  }
  for (const [index, source] of value.physicalSources4.entries()) {
    for (const [offset, occurrence] of source.htmlInspection.occurrences.entries()) result.push({ sourcePath: source.path,
      line: value.physicalHtmlSourceLocations[index].locations[offset].line, fullyInspected: occurrence.fullyInspected,
      explicitLocalTargets: occurrence.explicitLocalTargets });
  }
  for (const source of value.physicalHtmlSources4) result.push({ sourcePath: source.path, line: 1,
    fullyInspected: source.htmlInspection.fullyInspected, explicitLocalTargets: source.htmlInspection.explicitLocalTargets });
  return freeze(result);
}
export function workspaceOperationSourceHtmlOccurrencesV5(input: WorkspaceOperationMixedSourceEvidenceV5): readonly WorkspaceOperationHtmlOccurrenceV5[] {
  return htmlOccurrences(decodeWorkspaceOperationMixedSourceEvidenceV5(input));
}
/** Explicit new snapshot contract. Old gaps remain present; the future HTML-
 * aware planner must assess them, not infer readiness from a decoder/hash. */
export function workspaceOperationMixedSourceSnapshotV5(input: WorkspaceOperationMixedSourceEvidenceV5): WorkspaceOperationMixedSourceSnapshotV5 {
  const value = decodeWorkspaceOperationMixedSourceEvidenceV5(input);
  const gaps: PhysicalSourceGap[] = [...value.coverage.gaps,
    ...value.nativeOrdinarySources4.flatMap(source => source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path }))),
    ...value.physicalSources4.flatMap(source => source.coverage.gaps)];
  const body = { contractVersion: 5 as const, workspaceId: value.workspaceScope.workspaceId, namespace: value.namespace,
    documents: value.nativeOrdinarySources4.map(source => source.inventory), physicalSources: value.physicalSources4,
    physicalHtmlSources: value.physicalHtmlSources4, coverage: { complete: !gaps.length, gaps },
    htmlOccurrences: htmlOccurrences(value) };
  return freeze({ ...body, snapshotProof: proof(body) });
}
