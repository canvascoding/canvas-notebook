import 'server-only';

import { isDeepStrictEqual, types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../markdown/workspace-link-limits';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks, inspectOriginalPhysicalLinksV3, originalPhysicalSourceProof, workspaceSourceAuthorityStageProof,
  type OriginalPhysicalLinkInventory, type WorkspaceSourceAuthorityStage } from '../markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeSourceEvidenceV2, decodeWorkspaceOperationNativeSourceEvidence,
  isNativeSourceFilesystemFingerprint, WorkspaceOperationNativeSourceEvidenceError,
  type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';

export type PhysicalReadSourceEvidenceV3 = Readonly<Omit<OriginalPhysicalLinkInventory, 'originalBytes'>>;
export type WorkspaceOperationNativeSourceEvidenceV3 = Readonly<{
  evidenceVersion: 3;
  workspaceScope: WorkspaceOperationJobScope;
  namespace: WorkspaceSourceAuthorityStage['namespace'];
  scope: WorkspaceSourceAuthorityStage['scope'];
  coverage: { complete: true; gaps: [] };
  observedStageProof: string;
  nativeComponent: WorkspaceOperationNativeSourceEvidenceV2;
  physicalSources: readonly PhysicalReadSourceEvidenceV3[];
  semanticProof: string;
  evidenceProof: string;
}>;

function rejectV3Evidence(reason: 'invalid' | 'too-large' = 'invalid'): never {
  throw new WorkspaceOperationNativeSourceEvidenceError(reason === 'too-large'
    ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
}
/** Descriptor capture only. Typed bytes are handled separately, before JSON capture. */
function captureV3Object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) return rejectV3Evidence();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectV3Evidence();
    result[key] = descriptor.value;
  }
  return result;
}
function freezeV3Evidence<T>(input: T): T {
  if (typeof input === 'string' && Buffer.from(input).toString('utf8') !== input) return rejectV3Evidence();
  if (input && typeof input === 'object') {
    for (const child of Object.values(input)) freezeV3Evidence(child);
    Object.freeze(input);
  }
  return input;
}

/** Fresh capture reparses actual bytes. Historical decoding validates only facts,
 * never grants authority and does not reconstruct fictitious native identities. */
function physicalV3Inventory(input: unknown, original: boolean,
  budget: { bytes: number; links: number }): PhysicalReadSourceEvidenceV3 {
  const hasParserVersion = input !== null && typeof input === 'object' && !types.isProxy(input)
    && Object.hasOwn(input, 'parserVersion');
  const raw = captureV3Object(input, ['physicalSourceVersion', ...(hasParserVersion ? ['parserVersion'] : []), 'source', 'workspaceId', 'organizationId',
    'path', 'authority', 'physical', ...(original ? ['originalBytes'] : []), 'encoding', 'hasBom', 'lineEndings',
    'frontmatterPrefix', 'metadata', 'links', 'coverage', 'applicability', 'executionReady', 'physicalSourceProof']);
  const suppliedBytes = raw.originalBytes; delete raw.originalBytes;
  const value = freezeV3Evidence(captureWorkspaceOperationNativePlanData(raw, rejectV3Evidence, 8 * 1024 * 1024)) as PhysicalReadSourceEvidenceV3;
  const v3EvidenceInteger = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item)
    && item >= 0 && item < Number.MAX_SAFE_INTEGER && !Object.is(item, -0);
  const v3EvidenceDigest = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item);
  const v3EvidenceText = (item: unknown): item is string => typeof item === 'string';
  const v3EvidenceIdentifier = (item: unknown): item is string => v3EvidenceText(item) && item.length > 0 && item.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(item);
  const physical = captureV3Object(value.physical, ['filesystemIdentity', 'byteHash', 'byteLength']);
  const authority = captureV3Object(value.authority, value.authority.kind === 'unregistered' ? ['kind', 'catalogueProof']
    : ['kind', 'catalogueProof', 'registeredDocumentId', 'lineageId']);
  const metadata = captureV3Object(value.metadata, ['path', 'aliases', 'tags', 'title', 'hasExplicitTitle', 'headings', 'blockIds']);
  const endings = captureV3Object(value.lineEndings, ['style', 'lf', 'crlf', 'bareCr']);
  const coverage = captureV3Object(value.coverage, ['complete', 'gaps']);
  if (value.physicalSourceVersion !== 1 || value.parserVersion !== undefined && value.parserVersion !== 2 && value.parserVersion !== 3
    || value.source !== 'original-physical-bytes'
    || !v3EvidenceIdentifier(value.workspaceId) || value.organizationId !== null && !v3EvidenceIdentifier(value.organizationId)
    || !isCanonicalAdmissionPath(value.path) || value.path.length > 4096 || value.path.split('/').length > 33
    || !/\.(?:md|markdown)$/iu.test(value.path) || value.encoding !== 'utf8' || typeof value.hasBom !== 'boolean'
    || value.applicability !== 'requires-import-and-rebinding' || value.executionReady !== false
    || !isNativeSourceFilesystemFingerprint(physical.filesystemIdentity) || !v3EvidenceDigest(physical.byteHash)
    || !v3EvidenceInteger(physical.byteLength) || physical.byteLength > MAX_INDEXED_MARKDOWN_BYTES
    || Number(String(physical.filesystemIdentity).split(':')[2]) !== physical.byteLength
    || !['unregistered', 'registered-never-initialized'].includes(String(authority.kind)) || !v3EvidenceDigest(authority.catalogueProof)
    || authority.kind === 'registered-never-initialized' && (!v3EvidenceIdentifier(authority.registeredDocumentId)
      || authority.lineageId !== null && !v3EvidenceIdentifier(authority.lineageId))
    || coverage.complete !== true || !Array.isArray(coverage.gaps) || coverage.gaps.length
    || !v3EvidenceText(value.frontmatterPrefix) || Buffer.byteLength(value.frontmatterPrefix) > physical.byteLength
    || !['none', 'lf', 'crlf', 'mixed', 'bare-cr'].includes(String(endings.style))
    || ![endings.lf, endings.crlf, endings.bareCr].every(v3EvidenceInteger)
    || Number(endings.lf) + Number(endings.crlf) * 2 + Number(endings.bareCr) > physical.byteLength
    || metadata.path !== value.path || !v3EvidenceText(metadata.title) || typeof metadata.hasExplicitTitle !== 'boolean'
    || ![metadata.aliases, metadata.tags, metadata.blockIds].every(items => Array.isArray(items) && items.every(v3EvidenceText))
    || !Array.isArray(metadata.headings) || !Array.isArray(value.links) || value.links.length > budget.links) return rejectV3Evidence();
  const expectedStyle = endings.bareCr ? 'bare-cr' : endings.lf && endings.crlf ? 'mixed' : endings.lf ? 'lf' : endings.crlf ? 'crlf' : 'none';
  if (endings.style !== expectedStyle) return rejectV3Evidence();
  for (const heading of metadata.headings) {
    const row = captureV3Object(heading, ['depth', 'text']);
    if (!v3EvidenceInteger(row.depth) || row.depth < 1 || row.depth > 6 || !v3EvidenceText(row.text)) return rejectV3Evidence();
  }
  budget.links -= value.links.length;
  const ids = new Set<string>();
  for (const link of value.links) {
    captureV3Object(link, ['alias', 'embed', 'end', 'fragment', 'kind', 'raw', 'sourcePath', 'start', 'syntax',
      'targetEnd', 'targetLiteral', 'targetPathText', 'targetStart', 'workspaceRootRelative', 'physicalLinkId', 'syntaxRange', 'targetRange']);
    for (const range of [link.syntaxRange, link.targetRange]) {
      captureV3Object(range, ['startUtf16', 'endUtf16', 'startUtf8Byte', 'endUtf8Byte']);
      if (![range.startUtf16, range.endUtf16, range.startUtf8Byte, range.endUtf8Byte].every(v3EvidenceInteger)
        || range.startUtf16 > range.endUtf16 || range.startUtf8Byte > range.endUtf8Byte
        || range.endUtf16 > physical.byteLength || range.endUtf8Byte > physical.byteLength) return rejectV3Evidence();
    }
    if (!['wiki', 'markdown'].includes(link.kind)
      || !['inline-link', 'inline-image', 'reference-link', 'reference-image', 'reference-definition', 'wiki-link', 'wiki-embed'].includes(link.syntax)
      || link.sourcePath !== value.path || !v3EvidenceText(link.raw) || !v3EvidenceText(link.targetLiteral) || !v3EvidenceText(link.targetPathText)
      || link.alias !== null && !v3EvidenceText(link.alias) || link.fragment !== null && !v3EvidenceText(link.fragment)
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
        syntaxRange: link.syntaxRange, targetRange: link.targetRange, raw: link.raw })}`) return rejectV3Evidence();
    ids.add(link.physicalLinkId);
  }
  const { physicalSourceProof, ...body } = value;
  if (!v3EvidenceDigest(physicalSourceProof) || proof({ ...body, observedOriginalByteHash: physical.byteHash }) !== physicalSourceProof) return rejectV3Evidence();
  if (original) {
    if (!suppliedBytes || types.isProxy(suppliedBytes) || !ArrayBuffer.isView(suppliedBytes)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(suppliedBytes))
      || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(key => Object.hasOwn(suppliedBytes, key))) return rejectV3Evidence();
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(suppliedBytes) as number;
    const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(suppliedBytes) as ArrayBuffer;
    if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype || length !== physical.byteLength) return rejectV3Evidence();
    if (length > budget.bytes) return rejectV3Evidence('too-large');
    budget.bytes -= length;
    const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, suppliedBytes as Uint8Array);
    const parsed = (value.parserVersion === 3 ? inspectOriginalPhysicalLinksV3 : inspectOriginalPhysicalLinks)({ workspaceId: value.workspaceId, organizationId: value.organizationId,
      path: value.path, authority: value.authority, bytes, filesystemIdentity: value.physical.filesystemIdentity });
    // The absent historical marker is part of the original proof bytes. Replay
    // legacy semantics and remove only the new wrapper's explicit marker from
    // the comparison copy, never relabel the supplied historical evidence.
    if (!hasParserVersion) {
      delete parsed.parserVersion;
      parsed.physicalSourceProof = originalPhysicalSourceProof(parsed);
    }
    const { originalBytes: _private, ...actual } = parsed;
    if (!isDeepStrictEqual(actual, value)) return rejectV3Evidence();
  }
  return value;
}

function nativeV3Component(scope: WorkspaceOperationJobScope, observation: WorkspaceLinkSourceAuthorityObservation,
  physical: readonly PhysicalReadSourceEvidenceV3[]): WorkspaceOperationNativeSourceEvidenceV2 {
  const paths = new Set(physical.map(source => source.path)), stage = observation.stage;
  if (stage.namespace.some(entry => entry.kind === 'file' && entry.documentId === null
    && /\.(?:md|markdown)$/iu.test(entry.path) && !paths.has(entry.path))) return rejectV3Evidence();
  const body = { ...stage, namespace: stage.namespace.filter(entry => !paths.has(entry.path)),
    sources: stage.sources.filter((source): source is Extract<WorkspaceSourceAuthorityStage['sources'][number], { kind: 'native' }> => source.kind === 'native'),
    scope: { ...stage.scope, excludedPaths: [...new Set([...stage.scope.excludedPaths, ...paths])].sort() },
    readiness: 'native-coordinator-required' as const };
  return captureWorkspaceOperationNativeSourceEvidenceV2(scope, { ...observation,
    stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) } });
}

/** Charge all private source bytes and graph links before copying or parsing
 * either provider. Inspect only own data descriptors and typed-array slots. */
function preflightV3ObservationBudget(states: unknown, sources: unknown): void {
  let bytes = 32 * 1024 * 1024, links = 20_000;
  const field = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return rejectV3Evidence();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectV3Evidence();
    return descriptor.value;
  };
  const list = (value: unknown, maximum: number): unknown[] => {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return rejectV3Evidence();
    const size = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
    if (size > maximum) return rejectV3Evidence('too-large');
    if (Reflect.ownKeys(value).length !== size + 1) return rejectV3Evidence();
    return Array.from({ length: size }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectV3Evidence();
      return descriptor.value;
    });
  };
  const binary = (value: unknown, maximum: number): void => {
    if (!value || types.isProxy(value) || !ArrayBuffer.isView(value)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))
      || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(key => Object.hasOwn(value, key))) return rejectV3Evidence();
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    const size = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(value) as number;
    const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(value) as ArrayBuffer;
    if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return rejectV3Evidence();
    bytes -= size;
    if (size > maximum || bytes < 0) return rejectV3Evidence('too-large');
  };
  for (const state of list(states, 10_000)) {
    binary(field(state, 'yjsState'), 16 * 1024 * 1024); binary(field(state, 'stateVector'), 1024 * 1024);
  }
  for (const source of list(sources, 10_000)) {
    const kind = field(source, 'kind'), inventory = field(source, 'inventory');
    if (kind !== 'physical' && kind !== 'native') return rejectV3Evidence();
    links -= list(field(inventory, 'links'), 20_000).length;
    if (links < 0) return rejectV3Evidence('too-large');
    if (kind === 'physical') binary(field(inventory, 'originalBytes'), MAX_INDEXED_MARKDOWN_BYTES);
  }
}

function captureV3Observation(scope: WorkspaceOperationJobScope, input: unknown) {
  const raw = captureV3Object(input, ['stage', 'nativeBindings', 'privateNativeStates', 'privateCatalogue']);
  const row = captureV3Object(raw.stage, ['stageVersion', 'workspaceId', 'organizationId', 'catalogueProof', 'namespace',
    'sources', 'scope', 'coverage', 'readiness', 'executionReady', 'stageProof']);
  const sources = row.sources; delete row.sources;
  const facts = captureWorkspaceOperationNativePlanData(row, rejectV3Evidence, 8 * 1024 * 1024) as Omit<WorkspaceSourceAuthorityStage, 'sources'>;
  if (types.isProxy(sources) || !Array.isArray(sources) || Object.getPrototypeOf(sources) !== Array.prototype
    || sources.length > 10_000 || Reflect.ownKeys(sources).length !== sources.length + 1) return rejectV3Evidence();
  preflightV3ObservationBudget(raw.privateNativeStates, sources);
  const budget = { bytes: 32 * 1024 * 1024, links: 20_000 }, physicalSources: PhysicalReadSourceEvidenceV3[] = [];
  const capturedSources: WorkspaceSourceAuthorityStage['sources'] = [];
  for (let index = 0; index < sources.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(sources, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return rejectV3Evidence();
    const source = captureV3Object(descriptor.value, ['kind', 'inventory']);
    if (source.kind === 'physical') {
      const inventory = physicalV3Inventory(source.inventory, true, budget);
      const supplied = Object.getOwnPropertyDescriptor(source.inventory, 'originalBytes')!.value as Uint8Array;
      const bytes = new Uint8Array(inventory.physical.byteLength); Uint8Array.prototype.set.call(bytes, supplied);
      physicalSources.push(inventory);
      capturedSources.push({ kind: 'physical', inventory: { ...inventory, originalBytes: bytes } });
    } else if (source.kind === 'native') {
      // No proof may traverse the caller's objects. Capture descriptors before
      // hashing, then let the unchanged V2 codec validate the native facts.
      const inventory = captureWorkspaceOperationNativePlanData(source.inventory, rejectV3Evidence, 8 * 1024 * 1024) as
        Extract<WorkspaceSourceAuthorityStage['sources'][number], { kind: 'native' }>['inventory'];
      capturedSources.push({ kind: 'native', inventory });
    } else return rejectV3Evidence();
  }
  const stage = { ...facts, sources: capturedSources };
  const observation = { ...raw, stage } as unknown as WorkspaceLinkSourceAuthorityObservation;
  const nativeComponent = nativeV3Component(scope, observation, physicalSources);
  if (stage.stageVersion !== 1 || stage.executionReady !== false || stage.workspaceId !== nativeComponent.workspaceScope.workspaceId
    || stage.organizationId !== nativeComponent.workspaceScope.organizationId || stage.coverage.complete !== true
    || stage.coverage.gaps.length || stage.readiness !== (physicalSources.length ? 'requires-import-and-rebinding' : 'native-coordinator-required')
    || workspaceSourceAuthorityStageProof(stage) !== stage.stageProof) return rejectV3Evidence();
  const witness = captureWorkspaceOperationNativeCatalogueWitness(raw.privateCatalogue, nativeComponent.workspaceScope,
    nativeComponent.stage.catalogueProof!, nativeComponent.nativeBindings, rejectV3Evidence);
  const byPath = new Map(witness.entries.map(entry => [entry.path, entry]));
  const nativeIds = new Set(nativeComponent.nativeBindings.map(binding => binding.expected.documentId));
  for (const entry of witness.entries) {
    if (entry.authority === 'initialized' && !nativeIds.has(entry.id)) return rejectV3Evidence();
    if (/\.(?:md|markdown)$/iu.test(entry.path) && entry.authority !== 'initialized'
      && (entry.authority !== 'pristine' || !physicalSources.some(source => source.path === entry.path))) return rejectV3Evidence();
  }
  for (const source of physicalSources) {
    const entry = byPath.get(source.path), authority = source.authority;
    if (authority.catalogueProof !== stage.catalogueProof || authority.kind === 'unregistered' && entry
      || authority.kind === 'registered-never-initialized' && (!entry || entry.authority !== 'pristine'
        || entry.id !== authority.registeredDocumentId || entry.lineage_id !== authority.lineageId)) return rejectV3Evidence();
  }
  const typed = Object.getPrototypeOf(Uint8Array.prototype), length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
  // V2 already rejected hostile arrays, state descriptors and binary views.
  for (const state of observation.privateNativeStates) {
    budget.bytes -= Number(length.call(state.yjsState)) + Number(length.call(state.stateVector));
    if (budget.bytes < 0) return rejectV3Evidence('too-large');
  }
  return { stage, nativeComponent, physicalSources: physicalSources.sort((a, b) => a.path.localeCompare(b.path)) };
}

function semanticV3Evidence(value: Omit<WorkspaceOperationNativeSourceEvidenceV3, 'semanticProof' | 'evidenceProof'>) {
  return { semanticVersion: 3, workspaceScope: value.workspaceScope, scope: value.scope, coverage: value.coverage,
    nativeComponent: value.nativeComponent.semanticProof,
    physicalSources: value.physicalSources.map(source => {
      const { physicalSourceProof: _rawProof, links, authority, ...body } = source;
      return { ...body, authority: { ...authority, catalogueProof: value.nativeComponent.semanticCatalogueProof },
        links: links.map(({ physicalLinkId: _rawId, ...link }) => link) };
    }) };
}

function inspectV3Evidence(input: unknown): WorkspaceOperationNativeSourceEvidenceV3 {
  const captured = freezeV3Evidence(captureWorkspaceOperationNativePlanData(input, rejectV3Evidence, 8 * 1024 * 1024));
  if (Buffer.byteLength(JSON.stringify(captured)) > 8 * 1024 * 1024) return rejectV3Evidence('too-large');
  const row = captureV3Object(captured, ['evidenceVersion', 'workspaceScope', 'namespace', 'scope', 'coverage',
    'observedStageProof', 'nativeComponent', 'physicalSources', 'semanticProof', 'evidenceProof']);
  const value = row as unknown as WorkspaceOperationNativeSourceEvidenceV3;
  const component = decodeWorkspaceOperationNativeSourceEvidence(value.nativeComponent);
  if (value.evidenceVersion !== 3 || component.evidenceVersion !== 2 || !isDeepStrictEqual(value.workspaceScope, component.workspaceScope)
    || !Array.isArray(value.namespace) || value.namespace.length > 10_000 || !Array.isArray(value.physicalSources)
    || value.physicalSources.length + component.stage.sources.length > 10_000
    || typeof value.observedStageProof !== 'string' || !/^[a-f0-9]{64}$/u.test(value.observedStageProof)) return rejectV3Evidence();
  captureV3Object(value.scope, ['kind', 'excludedPaths']); captureV3Object(value.coverage, ['complete', 'gaps']);
  if (value.scope.kind !== 'visible-workspace' || !Array.isArray(value.scope.excludedPaths)
    || new Set(value.scope.excludedPaths).size !== value.scope.excludedPaths.length
    || value.scope.excludedPaths.some(path => !isCanonicalAdmissionPath(path) || path.length > 4096 || path.split('/').length > 33)
    || value.coverage.complete !== true || !Array.isArray(value.coverage.gaps) || value.coverage.gaps.length) return rejectV3Evidence();
  const budget = { bytes: 0, links: 20_000 - component.stage.sources.reduce((sum, source) => sum + source.inventory.links.length, 0) };
  if (budget.links < 0) return rejectV3Evidence('too-large');
  const physical = value.physicalSources.map(source => physicalV3Inventory(source, false, budget));
  if (!isDeepStrictEqual(physical.map(source => source.path), physical.map(source => source.path).sort((a, b) => a.localeCompare(b)))) return rejectV3Evidence();
  const paths = new Set<string>(), physicalByPath = new Map(physical.map(source => [source.path, source]));
  const documentIds = new Set(component.nativeBindings.map(binding => binding.expected.documentId));
  if (physicalByPath.size !== physical.length) return rejectV3Evidence();
  for (const source of physical) {
    if (source.workspaceId !== value.workspaceScope.workspaceId || source.organizationId !== value.workspaceScope.organizationId
      || source.authority.catalogueProof !== component.stage.catalogueProof) return rejectV3Evidence();
    if (source.authority.kind === 'registered-never-initialized') {
      if (documentIds.has(source.authority.registeredDocumentId)) return rejectV3Evidence();
      documentIds.add(source.authority.registeredDocumentId);
    }
  }
  for (const entry of value.namespace) {
    if (paths.has(entry.path) || value.scope.excludedPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) return rejectV3Evidence();
    paths.add(entry.path);
    const source = physicalByPath.get(entry.path);
    if (!source) continue;
    captureV3Object(entry, ['workspaceId', 'path', 'kind', 'identity', 'documentId', 'lifecycleGeneration', 'filesystemIdentity']);
    if (entry.workspaceId !== value.workspaceScope.workspaceId || entry.kind !== 'file' || entry.documentId !== null
      || entry.lifecycleGeneration !== null || entry.identity !== source.physical.filesystemIdentity
      || entry.filesystemIdentity !== source.physical.filesystemIdentity) return rejectV3Evidence();
  }
  if (physical.some(source => !paths.has(source.path))
    || !isDeepStrictEqual(value.namespace.filter(entry => !physicalByPath.has(entry.path)), component.stage.namespace)
    || !isDeepStrictEqual(component.stage.scope.excludedPaths, [...new Set([...value.scope.excludedPaths, ...physicalByPath.keys()])].sort())) return rejectV3Evidence();
  const byPath = new Map(value.namespace.map(entry => [entry.path, entry]));
  for (const entry of value.namespace) {
    const segments = entry.path.split('/'); segments.pop();
    while (segments.length) {
      if (byPath.get(segments.join('/'))?.kind !== 'directory') return rejectV3Evidence();
      segments.pop();
    }
  }
  const { evidenceProof, ...body } = value;
  if (value.semanticProof !== proof(semanticV3Evidence(value)) || evidenceProof !== proof(body)) return rejectV3Evidence();
  return freezeV3Evidence(value);
}

/** Complete fresh facts, no current authority, filesystem operation or import. */
export function captureWorkspaceOperationNativeSourceEvidenceV3(scope: WorkspaceOperationJobScope,
  observation: WorkspaceLinkSourceAuthorityObservation): WorkspaceOperationNativeSourceEvidenceV3 {
  try {
    const { stage, nativeComponent, physicalSources } = captureV3Observation(scope, observation);
    const facts = { evidenceVersion: 3 as const, workspaceScope: nativeComponent.workspaceScope, namespace: stage.namespace,
      scope: stage.scope, coverage: { complete: true as const, gaps: [] as [] }, observedStageProof: stage.stageProof,
      nativeComponent, physicalSources };
    const body = { ...facts, semanticProof: proof(semanticV3Evidence(facts)) };
    return inspectV3Evidence({ ...body, evidenceProof: proof(body) });
  } catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return rejectV3Evidence(); }
}

/** Historical read facts require no physical payload. They are never a grant. */
export function decodeWorkspaceOperationNativeSourceEvidenceV3(input: unknown): WorkspaceOperationNativeSourceEvidenceV3 {
  try { return inspectV3Evidence(input); }
  catch (error) { if (error instanceof WorkspaceOperationNativeSourceEvidenceError) throw error; return rejectV3Evidence(); }
}

/** Every current comparison requires the complete actual Catalogue witness. */
export function assertWorkspaceOperationNativeSourceEvidenceV3Current(expected: WorkspaceOperationNativeSourceEvidenceV3,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  const original = decodeWorkspaceOperationNativeSourceEvidenceV3(expected);
  const current = captureWorkspaceOperationNativeSourceEvidenceV3(scope, observation);
  if (original.semanticProof !== current.semanticProof) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
}
