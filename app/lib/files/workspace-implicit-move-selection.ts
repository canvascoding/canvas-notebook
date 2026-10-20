import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest, isCanonicalAdmissionPath,
  type CollaborationAdmissionDocument, type CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { isProtectedAppOutputFolder } from '../filesystem/app-output-folders';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceRequestHistoricalOrigin } from '../workspaces/request-principal';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { isInternalWorkspaceStagingPath } from './internal-staging-path';

type Selection = Readonly<{ sourcePath: string; destinationPath: string }>;
type AnchorBase = Readonly<{ path: string; role: 'selected' | 'parent' }>;
export type WorkspaceImplicitMoveAnchorV1 = AnchorBase & (
  Readonly<{ kind: 'native'; documentId: string; lineageId: string; lifecycleGeneration: number;
    representation: CollaborationAdmissionDocument['representation']; schemaVersion: number }>
  | Readonly<{ kind: 'pristine'; documentId: string; lineageId: string; filesystemIdentity: string }>
  | Readonly<{ kind: 'physical-file'; filesystemIdentity: string }>
  | Readonly<{ kind: 'physical-directory'; device: string; inode: string }>
  | Readonly<{ kind: 'virtual-directory'; identity: string }>
);
/** Immutable selection/history only. This is not a principal, owner, executable
 * plan, import receipt, SQL handle or reusable admission/mutation grant. */
export type WorkspaceImplicitMoveSelectionV1 = Readonly<{
  version: 1; kind: 'implicit-native-move-selection'; operationId: string; action: 'move' | 'rename';
  selections: readonly Selection[]; overwrite: false; ignoreMissing: false; expectedPlanId: null;
  origin: WorkspaceRequestHistoricalOrigin; scope: WorkspaceOperationJobScope;
  anchors: readonly WorkspaceImplicitMoveAnchorV1[];
  nativeDocumentIds: readonly string[]; nativeLineageIds: readonly string[];
  nativeDocumentsProof: string; batchId: string; requestHash: string;
}>;
export class WorkspaceImplicitMoveSelectionError extends Error {
  readonly status: 409 | 413;
  constructor(readonly code: 'IMPLICIT_MOVE_SELECTION_INVALID' | 'IMPLICIT_MOVE_SELECTION_CHANGED' | 'IMPLICIT_MOVE_SELECTION_TOO_LARGE') {
    super(code); this.name = 'WorkspaceImplicitMoveSelectionError'; this.status = code === 'IMPLICIT_MOVE_SELECTION_TOO_LARGE' ? 413 : 409;
  }
}
function fail(code: WorkspaceImplicitMoveSelectionError['code'] = 'IMPLICIT_MOVE_SELECTION_INVALID'): never {
  throw new WorkspaceImplicitMoveSelectionError(code);
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const validText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= maximum && Buffer.from(value).toString('utf8') === value && !/[\u0000-\u001f\u007f]/u.test(value);
const id = (value: unknown): value is string => validText(value, 256);
const nullableId = (value: unknown) => value === null || id(value);
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const pathValid = (value: unknown): value is string => validText(value, 4096) && isCanonicalAdmissionPath(value)
  && value.split('/').length <= 33 && !isProtectedAppOutputFolder(value) && !isInternalWorkspaceStagingPath(value);
function plain(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
}
function field(value: unknown, name: string): unknown {
  plain(value); const property = Object.getOwnPropertyDescriptor(value, name);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail(); return property.value;
}
function exact(value: unknown, names: readonly string[]): void {
  plain(value); if (Reflect.ownKeys(value).length !== names.length) fail(); for (const name of names) field(value, name);
}
function capture(value: unknown, maximum = 64 * 1024): unknown {
  return captureWorkspaceOperationNativePlanData(value, reason => fail(reason === 'too-large'
    ? 'IMPLICIT_MOVE_SELECTION_TOO_LARGE' : 'IMPLICIT_MOVE_SELECTION_INVALID'), maximum);
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
  });
}
function canonical(value: unknown): string {
  const visit = (value: unknown): unknown => Array.isArray(value) ? value.map(visit)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare)
      .map(key => [key, visit((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(visit(value));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value;
}
function parseOrigin(input: unknown, scope: WorkspaceOperationJobScope): WorkspaceRequestHistoricalOrigin {
  const value = capture(input); exact(value, ['userId','sessionId','impersonatedBy','workspaceId','workspaceType','organizationId',
    'customerId','projectId','ownerUserId','rootPath','rootRelativePath','legacy','status','schema','schemaOid','searchPath','databaseOid']);
  const origin = value as WorkspaceRequestHistoricalOrigin;
  if (!id(origin.userId) || !id(origin.sessionId) || !nullableId(origin.impersonatedBy)
    || !validText(origin.schema, 63) || origin.schema !== origin.schema.trim() || !validText(origin.searchPath, 4096)
    || !integer(origin.schemaOid) || !integer(origin.databaseOid) || origin.status !== 'active' || origin.legacy !== false
    || typeof origin.rootRelativePath !== 'string' || !isCanonicalAdmissionPath(origin.rootRelativePath, true)) fail();
  const { status: _status, userId: _user, sessionId: _session, impersonatedBy: _impersonation,
    schema: _schema, schemaOid: _schemaOid, searchPath: _searchPath, databaseOid: _databaseOid, ...originScope } = origin;
  let parsed: WorkspaceOperationJobScope; try { parsed = parseWorkspaceOperationJobScope({ version: 1, ...originScope }); } catch { return fail(); }
  if (!equal(parsed, scope) || scope.legacy) fail(); return origin;
}
function parseSelections(input: unknown): readonly Selection[] {
  const values = array(capture(input), 1000); if (!values.length) return fail();
  const selections = values.map(item => {
    exact(item, ['sourcePath','destinationPath']); const sourcePath = field(item, 'sourcePath'), destinationPath = field(item, 'destinationPath');
    if (!pathValid(sourcePath) || !pathValid(destinationPath) || sourcePath === destinationPath || within(destinationPath, sourcePath)) return fail();
    return { sourcePath, destinationPath };
  });
  for (const [index, item] of selections.entries()) for (const previous of selections.slice(0, index)) {
    if (within(item.sourcePath, previous.sourcePath) || within(previous.sourcePath, item.sourcePath)
      || within(item.destinationPath, previous.destinationPath) || within(previous.destinationPath, item.destinationPath)
      || within(item.destinationPath, previous.sourcePath) || within(previous.destinationPath, item.sourcePath)) fail();
  }
  return selections;
}
function batchIdentity(value: Pick<WorkspaceImplicitMoveSelectionV1, 'scope' | 'origin' | 'operationId' | 'action' | 'selections'>) {
  // Exact existing Web direct hashes: the historical route did not persist SID
  // in its authorization. The separately stored origin still binds its SID.
  const selections = value.selections.map(item => ({ sourcePath: item.sourcePath, destinationPath: item.destinationPath }));
  return { batchId: hash(['workspace-path-operation-id-v1', value.scope.workspaceId, value.origin.userId, value.operationId]),
    requestHash: hash(['workspace-path-operation-v1', value.scope.workspaceId, value.action, selections,
      false, false, null, value.origin.userId, 'user', value.origin.userId, null]) };
}
function requestIdFor(batchId: string): string {
  const hex = hash(['workspace-implicit-move-admission-v1', batchId]);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function parseFingerprint(value: unknown): readonly string[] {
  if (!validText(value, 256)) return fail(); const parts = value.split(':');
  if (parts.length !== 5 || !parts.slice(0,3).every(part => /^(0|[1-9][0-9]{0,30})$/u.test(part))
    || !parts.slice(3).every(part => /^-?(0|[1-9][0-9]{0,20})(\.[0-9]{1,20})?$/u.test(part) && Number.isFinite(Number(part)))) fail();
  return parts;
}
function parseAnchor(input: unknown): WorkspaceImplicitMoveAnchorV1 {
  plain(input); const kind = field(input, 'kind'), base = ['path','role','kind'];
  const fields = kind === 'native' ? ['documentId','lineageId','lifecycleGeneration','representation','schemaVersion']
    : kind === 'pristine' ? ['documentId','lineageId','filesystemIdentity'] : kind === 'physical-file' ? ['filesystemIdentity']
      : kind === 'physical-directory' ? ['device','inode'] : kind === 'virtual-directory' ? ['identity'] : fail();
  exact(input, [...base,...fields]); const value = input as unknown as WorkspaceImplicitMoveAnchorV1;
  if (!pathValid(value.path) || !['selected','parent'].includes(value.role)) fail();
  if (value.kind === 'native') {
    if (!id(value.documentId) || !id(value.lineageId) || !integer(value.lifecycleGeneration) || !integer(value.schemaVersion)
      || !['plain_text','tiptap_xml','tiptap_blocks'].includes(value.representation) || value.role !== 'selected') fail();
  } else if (value.kind === 'pristine') {
    if (!id(value.documentId) || !id(value.lineageId) || value.role !== 'selected') fail(); parseFingerprint(value.filesystemIdentity);
  } else if (value.kind === 'physical-file') { if (value.role !== 'selected') fail(); parseFingerprint(value.filesystemIdentity); }
  else if (value.kind === 'physical-directory') {
    if (![value.device,value.inode].every(part => /^(0|[1-9][0-9]{0,30})$/u.test(part))) fail();
  } else if (!/^registry-directory:[a-f0-9]{64}$/u.test(value.identity)) fail();
  return value;
}
function decodeSelection(input: unknown): WorkspaceImplicitMoveSelectionV1 {
  const value = capture(input); exact(value, ['version','kind','operationId','action','selections','overwrite','ignoreMissing','expectedPlanId',
    'origin','scope','anchors','nativeDocumentIds','nativeLineageIds','nativeDocumentsProof','batchId','requestHash']);
  const row = value as WorkspaceImplicitMoveSelectionV1;
  if (row.version !== 1 || row.kind !== 'implicit-native-move-selection' || !validText(row.operationId, 512)
    || !['move','rename'].includes(row.action) || row.overwrite !== false || row.ignoreMissing !== false || row.expectedPlanId !== null) fail();
  let scope: WorkspaceOperationJobScope; try { scope = parseWorkspaceOperationJobScope(row.scope); } catch { return fail(); }
  parseOrigin(row.origin, scope); const selections = parseSelections(row.selections), anchors = array(row.anchors, 10_000).map(parseAnchor);
  const ids = array(row.nativeDocumentIds, 1024); if (!digest(row.nativeDocumentsProof)) fail();
  if (ids.some((item, index) => !id(item) || index > 0 && compare(ids[index-1] as string, item) >= 0)) fail();
  const nativeLineages = array(row.nativeLineageIds,1024);
  if (nativeLineages.length !== ids.length || nativeLineages.some(item => !id(item))
    || new Set(nativeLineages).size !== nativeLineages.length) fail();
  const paths = new Set<string>(), documentIds = new Set<string>(), lineages = new Set<string>();
  for (const [index, anchor] of anchors.entries()) {
    if (paths.has(anchor.path) || index > 0 && compare(anchors[index-1].path, anchor.path) >= 0) fail(); paths.add(anchor.path);
    const selected = selections.some(item => within(anchor.path, item.sourcePath));
    if (anchor.role !== (selected ? 'selected' : 'parent') || !selected && !selections.some(item =>
      within(item.sourcePath, anchor.path) || within(item.destinationPath, anchor.path))) fail();
    if (anchor.kind === 'native' || anchor.kind === 'pristine') {
      if (documentIds.has(anchor.documentId) || lineages.has(anchor.lineageId) || anchor.kind === 'native' && !ids.includes(anchor.documentId)
        || anchor.kind === 'pristine' && ids.includes(anchor.documentId)) fail(); documentIds.add(anchor.documentId); lineages.add(anchor.lineageId);
      if (anchor.kind === 'native' && nativeLineages[ids.indexOf(anchor.documentId)] !== anchor.lineageId
        || anchor.kind === 'pristine' && nativeLineages.includes(anchor.lineageId)) fail();
    }
  }
  if (selections.some(item => !anchors.some(anchor => anchor.path === item.sourcePath && anchor.role === 'selected'))
    || !equal(batchIdentity(row), { batchId: row.batchId, requestHash: row.requestHash })) fail();
  // Enforce the unchanged Admission payload byte/depth/node budget, including
  // direct users of this pure decoder and digest function.
  try { collaborationAdmissionActionDigest(row.action, canonical(row)); } catch { return fail('IMPLICIT_MOVE_SELECTION_TOO_LARGE'); }
  return freeze(row);
}
type ObservationFacts = { anchors: readonly WorkspaceImplicitMoveAnchorV1[];
  documents: readonly CollaborationAdmissionDocument[]; lineageIds: readonly string[] };
/** Project only identities. Never serialize transient Yjs bytes or content
 * clocks, and never treat this data projection as proof of a genuine read. */
function observationFacts(scope: WorkspaceOperationJobScope, selections: readonly Selection[], input: WorkspaceLinkSourceAuthorityObservation): ObservationFacts {
  plain(input); const stage = field(input, 'stage'); plain(stage);
  if (field(stage, 'workspaceId') !== scope.workspaceId || field(stage, 'organizationId') !== scope.organizationId) fail();
  const namespace = array(capture(field(stage, 'namespace'), 16 * 1024 * 1024), 10_000) as Record<string, unknown>[];
  const bindings = array(capture(field(input, 'nativeBindings'), 16 * 1024 * 1024), 1024) as Record<string, unknown>[];
  const catalogue = array(capture(field(input, 'privateCatalogue'), 16 * 1024 * 1024), 10_000) as Record<string, unknown>[];
  const states = array(field(input, 'privateNativeStates'), 1024).map(raw => {
    const keys = ['documentId','workspaceId','organizationId','path','representation','lifecycleGeneration','schemaVersion','status'];
    return capture(Object.fromEntries(keys.map(key => [key, field(raw, key)]))) as Record<string, unknown>;
  });
  const entries = new Map<string, Record<string, unknown>>(), catalogueByPath = new Map<string, Record<string, unknown>>();
  const catalogueIds = new Set<string>();
  for (const entry of namespace) {
    if (entry.workspaceId !== scope.workspaceId || !pathValid(entry.path) || !['file','directory'].includes(String(entry.kind))
      || typeof entry.identity !== 'string' || entry.provider !== undefined || entries.has(entry.path)) fail(); entries.set(entry.path, entry);
  }
  for (const row of catalogue) {
    if (!id(row.id) || !id(row.lineage_id) || row.workspace_id !== scope.workspaceId || row.organization_id !== scope.organizationId
      || !pathValid(row.path) || row.status !== 'active' || catalogueByPath.has(row.path) || catalogueIds.has(row.id)
      || !['initialized','pristine'].includes(String(row.authority))) fail();
    catalogueByPath.set(row.path, row); catalogueIds.add(row.id);
  }
  const byDocument = new Map<string, { document: CollaborationAdmissionDocument; lineageId: string }>();
  for (const binding of bindings) {
    const expected = field(binding, 'expected') as Record<string, unknown>, registry = field(binding, 'registry') as Record<string, unknown>, lineage = field(binding, 'lineage') as Record<string, unknown>;
    plain(expected); plain(registry); plain(lineage); const row = catalogueByPath.get(String(expected.path)), entry = entries.get(String(expected.path));
    if (!id(expected.documentId) || !id(expected.lineageId) || !pathValid(expected.path) || !integer(expected.lifecycleGeneration)
      || !integer(expected.schemaVersion) || !['plain_text','tiptap_xml','tiptap_blocks'].includes(String(expected.representation))
      || expected.workspaceId !== scope.workspaceId || expected.organizationId !== scope.organizationId || byDocument.has(expected.documentId)
      || !row || row.authority !== 'initialized' || row.id !== expected.documentId || row.lineage_id !== expected.lineageId
      || row.has_persisted_state !== true || row.lifecycle_generation !== expected.lifecycleGeneration || row.yjs_state_lifecycle !== 'initialized'
      || row.state_status !== 'active' || row.state_path !== expected.path || row.state_workspace_id !== scope.workspaceId || row.state_organization_id !== scope.organizationId
      || !entry || entry.kind !== 'file' || entry.documentId !== expected.documentId || entry.lifecycleGeneration !== expected.lifecycleGeneration) fail();
    if (registry.documentId !== expected.documentId || registry.lineageId !== expected.lineageId || registry.provider !== 'yjs'
      || registry.stateLifecycle !== 'initialized' || registry.status !== 'active' || lineage.lineageId !== expected.lineageId
      || lineage.status !== 'active' || lineage.archivedAt !== null) fail();
    for (const current of [registry,lineage]) if (current.workspaceId !== scope.workspaceId || current.workspaceType !== scope.workspaceType
      || current.organizationId !== scope.organizationId || current.customerId !== scope.customerId || current.projectId !== scope.projectId || current.path !== expected.path) fail();
    const document: CollaborationAdmissionDocument = { documentId: expected.documentId, workspaceId: scope.workspaceId,
      organizationId: scope.organizationId, path: expected.path, representation: expected.representation as CollaborationAdmissionDocument['representation'],
      lifecycleGeneration: expected.lifecycleGeneration, schemaVersion: expected.schemaVersion, status: 'active' };
    const matching = states.filter(state => state.documentId === document.documentId);
    if (matching.length !== 1 || !equal(matching[0], document)) fail();
    byDocument.set(document.documentId, { document, lineageId: expected.lineageId });
  }
  if (states.length !== byDocument.size || catalogue.filter(row => row.authority === 'initialized').length !== byDocument.size
    || namespace.filter(entry => entry.documentId !== null).length !== byDocument.size) fail();
  for (const row of catalogue.filter(row => row.authority === 'pristine')) {
    const entry = entries.get(row.path as string);
    if (row.state_version !== 0 || row.yjs_state_lifecycle !== 'never_initialized' || row.has_persisted_state !== false || row.has_state_history !== false
      || ['lifecycle_generation','state_status','state_path','state_workspace_id','state_organization_id'].some(key => row[key] !== null)
      || !entry || entry.kind !== 'file' || entry.documentId !== null || entry.lifecycleGeneration !== null) fail(); parseFingerprint(entry.filesystemIdentity);
  }
  const wanted = new Set<string>();
  for (const selection of selections) {
    if (!entries.has(selection.sourcePath)) fail();
    for (const entry of namespace) if (within(entry.path as string, selection.sourcePath)) wanted.add(entry.path as string);
    for (const leaf of [selection.sourcePath,selection.destinationPath]) {
      const parts = leaf.split('/'); for (let length = 1; length < parts.length; length++) {
        const parent = parts.slice(0,length).join('/'), entry = entries.get(parent); if (entry) { if (entry.kind !== 'directory') fail(); wanted.add(parent); }
      }
    }
  }
  const anchors = [...wanted].sort(compare).map(path => {
    const entry = entries.get(path)!, row = catalogueByPath.get(path), role = selections.some(selection => within(path, selection.sourcePath)) ? 'selected' as const : 'parent' as const;
    if (entry.documentId !== null) {
      const native = byDocument.get(entry.documentId as string); if (!native) return fail();
      return parseAnchor({ path, role, kind: 'native', documentId: native.document.documentId, lineageId: native.lineageId,
        lifecycleGeneration: native.document.lifecycleGeneration, representation: native.document.representation, schemaVersion: native.document.schemaVersion });
    }
    if (entry.lifecycleGeneration !== null) return fail();
    if (entry.kind === 'directory') {
      if (entry.filesystemIdentity === null) return parseAnchor({ path, role, kind: 'virtual-directory', identity: entry.identity });
      const [device,inode] = parseFingerprint(entry.filesystemIdentity); if (entry.identity !== entry.filesystemIdentity) return fail();
      return parseAnchor({ path, role, kind: 'physical-directory', device, inode });
    }
    parseFingerprint(entry.filesystemIdentity); if (entry.identity !== entry.filesystemIdentity) return fail();
    return row?.authority === 'pristine' ? parseAnchor({ path, role, kind: 'pristine', documentId: row.id, lineageId: row.lineage_id,
      filesystemIdentity: entry.filesystemIdentity }) : parseAnchor({ path, role, kind: 'physical-file', filesystemIdentity: entry.filesystemIdentity });
  });
  const natives = [...byDocument.values()].sort((a,b) => compare(a.document.documentId,b.document.documentId));
  return { anchors, documents: natives.map(value => value.document), lineageIds: natives.map(value => value.lineageId) };
}
function documentsProof(documents: readonly CollaborationAdmissionDocument[], lineageIds: readonly string[]): string {
  if (documents.length !== lineageIds.length) return fail();
  return sha(`canvas.implicit-move-documents.v1\0${canonical(documents.map((document,index) => ({
    document, lineageId: lineageIds[index] })))}`);
}
/** Deterministic history lookup only. No collection or authorization occurs. */
export function getWorkspaceImplicitMoveRequestIdentity(input: { workspaceId: string; userId: string; operationId: string }) {
  const value = capture(input); exact(value, ['workspaceId','userId','operationId']);
  const workspaceId = field(value,'workspaceId'), userId = field(value,'userId'), operationId = field(value,'operationId');
  if (!id(workspaceId) || !id(userId) || !validText(operationId,512)) fail();
  const batchId = hash(['workspace-path-operation-id-v1',workspaceId,userId,operationId]);
  return Object.freeze({ batchId, requestId: requestIdFor(batchId) });
}
export function getWorkspaceImplicitMoveSelectionBatchIdentity(input: WorkspaceImplicitMoveSelectionV1) {
  const selection = decodeSelection(input); return Object.freeze({ batchId: selection.batchId, requestHash: selection.requestHash });
}
export function getWorkspaceImplicitMoveSelectionDigest(input: WorkspaceImplicitMoveSelectionV1): string {
  return sha(`canvas.implicit-move-selection.v1\0${canonical(decodeSelection(input))}`);
}
export function captureWorkspaceImplicitMoveSelection(input: {
  operationId: string; kind: 'move' | 'rename'; selections: readonly Selection[];
  origin: WorkspaceRequestHistoricalOrigin; scope: WorkspaceOperationJobScope; observation: WorkspaceLinkSourceAuthorityObservation;
}): Readonly<{ selection: WorkspaceImplicitMoveSelectionV1; request: CollaborationAdmissionRequest; selectionDigest: string }> {
  exact(input, ['operationId','kind','selections','origin','scope','observation']);
  let scope: WorkspaceOperationJobScope; try { scope = parseWorkspaceOperationJobScope(capture(field(input,'scope'))); } catch { return fail(); }
  const origin = parseOrigin(field(input,'origin'), scope), selections = parseSelections(field(input,'selections'));
  const operationId = field(input,'operationId'), action = field(input,'kind');
  if (!validText(operationId,512) || action !== 'move' && action !== 'rename') fail();
  const facts = observationFacts(scope, selections, field(input,'observation') as WorkspaceLinkSourceAuthorityObservation);
  const body: Omit<WorkspaceImplicitMoveSelectionV1, 'batchId' | 'requestHash'> = { version: 1, kind: 'implicit-native-move-selection', operationId, action, selections,
    overwrite: false as const, ignoreMissing: false as const, expectedPlanId: null, origin, scope, anchors: facts.anchors,
    nativeDocumentIds: facts.documents.map(document => document.documentId), nativeLineageIds: facts.lineageIds,
    nativeDocumentsProof: documentsProof(facts.documents,facts.lineageIds) };
  const selection = decodeSelection({ ...body,...batchIdentity(body) });
  const actionPayloadText = canonical(selection);
  const request = captureCollaborationAdmissionRequest({ requestId: requestIdFor(selection.batchId), actorId: origin.userId, action,
    actionPayloadText, actionDigest: collaborationAdmissionActionDigest(action, actionPayloadText),
    scopes: [{ workspaceId: scope.workspaceId, organizationId: scope.organizationId, path: '', kind: 'subtree' }], expectedDocuments: facts.documents }).request;
  // Writer/reader parity before reservation: even a valid bounded action
  // payload cannot create an outer request that our durable reader rejects.
  decodeWorkspaceImplicitMoveSelectionRequest(request);
  return freeze({ selection, request, selectionDigest: getWorkspaceImplicitMoveSelectionDigest(selection) });
}
export function decodeWorkspaceImplicitMoveSelectionRequest(input: CollaborationAdmissionRequest): WorkspaceImplicitMoveSelectionV1 {
  const captured = capture(input, 2 * 1024 * 1024); exact(captured, ['requestId','actorId','action','actionDigest','actionPayloadText','scopes','expectedDocuments']);
  const scopes = array(field(captured,'scopes'),64); if (scopes.length !== 1) fail();
  for (const scope of scopes) exact(scope, ['workspaceId','organizationId','path','kind']);
  for (const document of array(field(captured,'expectedDocuments'),1024)) exact(document,
    ['documentId','workspaceId','organizationId','path','representation','lifecycleGeneration','schemaVersion','status']);
  let request: CollaborationAdmissionRequest; try { request = captureCollaborationAdmissionRequest(captured as CollaborationAdmissionRequest).request; } catch { return fail(); }
  if (!equal(captured,request)) fail();
  if (typeof request.actionPayloadText !== 'string') return fail(); let parsed: unknown;
  try { parsed = JSON.parse(request.actionPayloadText); } catch { return fail(); }
  const selection = decodeSelection(parsed);
  if (request.actionPayloadText !== canonical(selection) || request.requestId !== requestIdFor(selection.batchId)
    || request.actorId !== selection.origin.userId || request.action !== selection.action
    || !equal(request.scopes, [{ workspaceId: selection.scope.workspaceId, organizationId: selection.scope.organizationId, path: '', kind: 'subtree' }])
    || !equal(request.expectedDocuments.map(document => document.documentId), selection.nativeDocumentIds)
    || documentsProof(request.expectedDocuments,selection.nativeLineageIds) !== selection.nativeDocumentsProof) fail();
  for (const anchor of selection.anchors) if (anchor.kind === 'native') {
    const document = request.expectedDocuments.find(document => document.documentId === anchor.documentId);
    if (!document || document.path !== anchor.path || document.lifecycleGeneration !== anchor.lifecycleGeneration
      || document.representation !== anchor.representation || document.schemaVersion !== anchor.schemaVersion || document.status !== 'active') fail();
  }
  return selection;
}
export function assertWorkspaceImplicitMoveSelectionCurrent(input: WorkspaceImplicitMoveSelectionV1, current: {
  origin: WorkspaceRequestHistoricalOrigin; scope: WorkspaceOperationJobScope; observation: WorkspaceLinkSourceAuthorityObservation;
}): void {
  exact(current, ['origin','scope','observation']); const selection = decodeSelection(input);
  let scope: WorkspaceOperationJobScope; try { scope = parseWorkspaceOperationJobScope(capture(field(current,'scope'))); } catch { return fail(); }
  const origin = parseOrigin(field(current,'origin'), scope);
  const facts = observationFacts(scope, selection.selections, field(current,'observation') as WorkspaceLinkSourceAuthorityObservation);
  if (!equal(origin, selection.origin) || !equal(scope, selection.scope) || !equal(facts.anchors, selection.anchors)
    || !equal(facts.documents.map(document => document.documentId), selection.nativeDocumentIds)
    || !equal(facts.lineageIds,selection.nativeLineageIds)
    || documentsProof(facts.documents,facts.lineageIds) !== selection.nativeDocumentsProof) fail('IMPLICIT_MOVE_SELECTION_CHANGED');
}
