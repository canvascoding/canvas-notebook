import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { SqlConnection } from '../db';
import type { CollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import type { WorkspaceOperationBatchClaimBinding, WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { persistWorkspacePathOriginalMarkdownImportOnConnection,
  assertWorkspacePathImportedOriginalsOnConnection } from '../collaboration/markdown-file-import-persistence';
import type { WorkspaceContext } from '../workspaces/types';
import { withWorkspaceRequestPrincipalOnConnection, type WorkspaceRequestPrincipal,
  type WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { withDirectMcpWorkspaceMoveOriginalImportPrincipalOnConnection, withDirectMcpWorkspaceDeleteOriginalImportPrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipal, type DirectMcpWorkspaceDeletePrincipal,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { buildWorkspaceMixedReadLinkGraphV3 } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { parseObsidianWikiTarget } from '../markdown/obsidian-flavored-markdown';
import type { MixedReadResolvedLinkV3 } from '../markdown/workspace-link-contract-v3';
import type { PhysicalNativeImportBindingV1 } from '../markdown/physical-native-import-binding';
import { assertWorkspaceFileLifecycleSourceLeaseCurrent, assertWorkspaceFileLifecycleSqlAvailable } from './workspace-file-lifecycle-guard';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { workspaceOperationMixedSourceSnapshot } from './workspace-operation-mixed-source-evidence';
import { createWorkspaceOperationNativeMoveBatchPlan, createWorkspaceOperationNativeMoveBatchPlanV3 } from './workspace-operation-native-move-plan';
import { createWorkspaceOperationNativeDeleteBatchPlan, createWorkspaceOperationNativeDeleteBatchPlanV3 } from './workspace-operation-native-delete-plan';
import { workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { decodeWorkspacePathImportPreparationPlanV1, assertWorkspacePathImportPreparationPlanV1Current,
  type WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import { decodeWorkspacePathAnyImportPreparationRecord, readWorkspacePathImportPreparationRecordOnConnection,
  insertWorkspacePathImportPreparationRecordOnConnection, type WorkspacePathImportPreparationRecord, type WorkspacePathImportPreparationRecordV1 } from './workspace-path-import-preparation-record';

import { createWorkspaceOperationNativeMoveBatchPlanV4 } from './workspace-operation-native-move-plan';
import { createWorkspaceOperationNativeDeleteBatchPlanV4 } from './workspace-operation-native-delete-html-plan';
import { createWorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import { decodeWorkspacePathHtmlImportPreparationPlanV4, assertWorkspacePathHtmlImportPreparationPlanV4Current,
  type WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import { captureWorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { assertWorkspacePathHtmlImportsCurrentGraphV4 } from './workspace-path-html-import-graph';
import type { WorkspacePathHtmlImportPreparationRecordV2 } from './workspace-path-html-import-record';
import { captureRawHtmlNativeBindingV1 } from '../markdown/workspace-raw-html-source-binding';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';

declare const preparationBrand: unique symbol;
export type WorkspacePathImportPreparationHandle = Readonly<{ [preparationBrand]: never }>;
export type WorkspacePathImportPreparationPrincipal = Readonly<{ kind: 'request'; principal: WorkspaceRequestPrincipal }>
  | Readonly<{ kind: 'move'; principal: DirectMcpWorkspaceMovePrincipal }>
  | Readonly<{ kind: 'delete'; principal: DirectMcpWorkspaceDeletePrincipal }>;
type Access = WorkspaceRequestPrincipalAccess | DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess;
type Origin = WorkspacePathImportPreparationRecord['origin'];
export type WorkspacePathImportPreparationInput = Readonly<{ principal: WorkspacePathImportPreparationPrincipal;
  operationId: string; plan: WorkspacePathImportPreparationPlanV1 | WorkspacePathHtmlImportPreparationPlanV4 }>;
export type WorkspacePathImportOperationPreparation = Readonly<{
  record: WorkspacePathImportPreparationRecord; batch: WorkspaceOperationBatchRecord }>;
type OperationFacts = Readonly<{ batch: WorkspaceOperationBatchRecord; binding: WorkspaceOperationBatchClaimBinding }>;
type Identity = Readonly<{ schemaName: string; schemaOid: number; databaseOid: number; backend: number;
  start: string; searchPath: string; xid: string }>;
type Frame = { active: boolean; database: SqlConnection; access: Access; identity: Identity; origin: Origin;
  operationId: string; plan: WorkspacePathImportPreparationPlanV1 | WorkspacePathHtmlImportPreparationPlanV4; nextIndex: number;
  bindings: PhysicalNativeImportBindingV1[]; purpose: 'import-only' | 'operation';
  record?: WorkspacePathImportPreparationRecord; operation?: OperationFacts; admissionRequest?: CollaborationAdmissionRequest };
const frames = new WeakMap<WorkspacePathImportPreparationHandle, Frame>();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const relations = ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_yjs_state_backups',
  'collaboration_agent_operations', 'file_collaboration_lineages', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_markdown_file_import_receipts', 'workspace_path_import_preparations'];
export class WorkspacePathImportPreparationPhaseError extends Error {
  readonly status = 409;
  constructor(readonly code: 'PATH_IMPORT_PREPARATION_PHASE_REQUIRED' | 'PATH_IMPORT_PREPARATION_PHASE_CHANGED'
    | 'PATH_IMPORT_PREPARATION_NOT_READY') { super(code); this.name = 'WorkspacePathImportPreparationPhaseError'; }
}
const fail = (code: WorkspacePathImportPreparationPhaseError['code'] = 'PATH_IMPORT_PREPARATION_PHASE_REQUIRED'): never => {
  throw new WorkspacePathImportPreparationPhaseError(code);
};
function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
}
function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Reflect.ownKeys(value).length !== keys.length) return fail();
  for (const key of keys) field(value, key);
}
async function realm(database: SqlConnection): Promise<Origin['realm']> {
  const row = await database.get(`SELECT pg_catalog.current_schema() AS schema_name,n.oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid
    FROM pg_catalog.pg_namespace n WHERE n.nspname=pg_catalog.current_schema()`) as Record<string, unknown> | undefined;
  if (!row || typeof row.schema_name !== 'string' || !row.schema_name || Buffer.byteLength(row.schema_name) > 63
    || /[\u0000-\u001f\u007f]/u.test(row.schema_name) || ![row.schema_oid, row.database_oid].every(value =>
      Number.isSafeInteger(Number(value)) && Number(value) > 0)) return fail();
  return Object.freeze({ schemaName: row.schema_name, schemaOid: Number(row.schema_oid), databaseOid: Number(row.database_oid) });
}
async function identity(database: SqlConnection): Promise<Identity> {
  const scope = await realm(database);
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,a.backend_start::text AS start,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.quote_ident(pg_catalog.current_schema())||', pg_catalog, pg_temp' AS canonical_path,pg_catalog.pg_current_xact_id()::text AS xid,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1 || typeof row.start !== 'string' || !row.start
    || typeof row.search_path !== 'string' || row.search_path !== row.canonical_path
    || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') return fail();
  return Object.freeze({ ...scope, backend: Number(row.backend), start: row.start, searchPath: row.search_path, xid: row.xid });
}
async function assertRelations(database: SqlConnection, schema: string): Promise<void> {
  const rows = await database.all(`SELECT name,pg_catalog.to_regclass(name)::oid=
    pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(name))::oid AS same
    FROM pg_catalog.unnest($2::text[]) names(name)`, [quote(schema), relations]) as Array<{ same: unknown }>;
  if (rows.length !== relations.length || rows.some(row => row.same !== true)) return fail();
}
function assertAccess(access: Access, plan: WorkspacePathImportPreparationPlanV1 | WorkspacePathHtmlImportPreparationPlanV4): void {
  const workspace = access.workspace;
  if (workspace.legacy || workspace.status !== undefined && workspace.status !== 'active'
    || !workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || !equal(captureWorkspaceOperationJobScope(workspace), plan.scope)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
}
async function assertFrame(database: SqlConnection, handle: WorkspacePathImportPreparationHandle): Promise<Frame> {
  const frame = frames.get(handle);
  if (!frame?.active || frame.database !== database) return fail();
  await frame.access.assertCurrent();
  assertAccess(frame.access, frame.plan);
  await assertWorkspaceFileLifecycleSourceLeaseCurrent(database, frame.plan.scope.workspaceId);
  if (!equal(frame.identity, await identity(database))) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  await assertRelations(database, frame.identity.schemaName);
  if (!frame.active || frames.get(handle) !== frame) return fail(); return frame;
}

/** Fixed central-import bridge only. A handle is minted solely inside the
 * current genuine B0 below and never returned. Prior indices allow FD checks;
 * the import module independently rejects repeated/reentrant births. */
export async function assertWorkspacePathMarkdownImportPreparationOnConnection(database: SqlConnection,
  handle: WorkspacePathImportPreparationHandle, requirementIndex: number) {
  const frame = await assertFrame(database, handle);
  if (!Number.isSafeInteger(requirementIndex) || requirementIndex < 0 || requirementIndex > frame.nextIndex
    || requirementIndex >= frame.plan.importRequirements.length
    || requirementIndex < frame.nextIndex && !frame.bindings[requirementIndex]) return fail();
  const requirement = frame.plan.importRequirements[requirementIndex];
  const original = frame.plan.version === 4 ? frame.plan.sourceBindings.find(binding => binding.sourcePath === requirement.path)?.original3
    : frame.plan.sourceEvidence.physicalSources.find(source => source.path === requirement.path);
  if (!original || original.physicalSourceProof !== requirement.physicalSourceProof) return fail();
  return Object.freeze({ workspace: frame.access.workspace as WorkspaceContext, userId: frame.origin.userId,
    sessionId: frame.origin.sessionId, parentOperationId: frame.operationId, previewPlanId: frame.plan.planId, requirement, original });
}
export async function assertWorkspacePathImportRecordPreparationOnConnection(database: SqlConnection,
  handle: WorkspacePathImportPreparationHandle, record: WorkspacePathImportPreparationRecord): Promise<void> {
  const frame = await assertFrame(database, handle);
  if (!frame.record || frame.nextIndex !== frame.plan.importRequirements.length
    || !equal(captureWorkspaceOperationNativePlanData(record, () => fail()), frame.record)) return fail();
}

/** Fixed operation writers alone consume these same-B0 original facts. No
 * claim is minted: the ordinary store acquires one after confirmed COMMIT. */
export async function assertWorkspacePathImportOperationPreparationOnConnection(database: SqlConnection,
  handle: WorkspacePathImportPreparationHandle) {
  const frame = await assertFrame(database, handle);
  if (frame.purpose !== 'operation' || !frame.record || frame.nextIndex !== frame.plan.importRequirements.length) return fail();
  return Object.freeze({ record: frame.record, access: frame.access, operation: frame.operation });
}

/** The reservation cannot choose its own request: only the fixed P0 writer's
 * returned request is retained in this private live operation frame. */
export async function assertWorkspacePathImportOperationAdmissionPreparationOnConnection(database: SqlConnection,
  handle: WorkspacePathImportPreparationHandle) {
  const frame = await assertWorkspacePathImportOperationPreparationOnConnection(database, handle);
  const request = frames.get(handle)?.admissionRequest;
  if (!frame.operation || !request) return fail();
  return Object.freeze({ ...frame, request });
}

function edgeResolution(edge: MixedReadResolvedLinkV3, identityMap: ReadonlyMap<string, string>, anchorIdentity?: string) {
  if (anchorIdentity && edge.kind === 'wiki' && edge.classification === 'anchor-only'
    && parseObsidianWikiTarget(edge.literal)?.path === '') {
    return { status: 'resolved', target: anchorIdentity, candidates: [anchorIdentity] };
  }
  return { status: edge.resolution.status, target: edge.resolution.target
    ? identityMap.get(edge.resolution.target.identity) ?? edge.resolution.target.identity : null,
  candidates: edge.resolution.candidates.map(item => identityMap.get(item.identity) ?? item.identity).sort() };
}
/** Genuine import receipts bridge original physical identities/occurrences to
 * actual fresh native ones. The namespace has not moved in B0. No import may
 * silently change a surviving link's original resolution before execution. */
function assertImportedGraph(plan: WorkspacePathImportPreparationPlanV1, bindings: readonly PhysicalNativeImportBindingV1[],
  current: ReturnType<typeof captureWorkspaceOperationNativeSourceEvidenceV3>): void {
  const before = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(plan.sourceEvidence));
  const after = buildWorkspaceMixedReadLinkGraphV3(workspaceOperationMixedSourceSnapshot(current));
  const byPath = new Map(bindings.map(binding => [binding.source.path, binding]));
  const identities = new Map<string, string>(), used = new Set<MixedReadResolvedLinkV3>();
  const unchangedPhysicalIds = new Map<string, Map<string, string>>();
  for (const original of plan.sourceEvidence.physicalSources) {
    if (byPath.has(original.path)) continue;
    const matches = current.physicalSources.filter(source => source.path === original.path);
    if (matches.length !== 1) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const actual = matches[0];
    // Every immutable source/profile/FD/hash fact stays exact. A genuine
    // import changes the catalogue proof, hence the derived source/link IDs,
    // even for a completely untouched Raw reader. Never discard that reader.
    const { physicalSourceProof: _originalProof, authority: originalAuthority, links: originalLinks, ...originalFacts } = original;
    const { physicalSourceProof: _actualProof, authority: actualAuthority, links: actualLinks, ...actualFacts } = actual;
    const { catalogueProof: _originalCatalogue, ...originalAuthorityFacts } = originalAuthority;
    const { catalogueProof: _actualCatalogue, ...actualAuthorityFacts } = actualAuthority;
    if (!equal(originalFacts, actualFacts) || !equal(originalAuthorityFacts, actualAuthorityFacts)
      || originalLinks.length !== actualLinks.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const actualByOccurrence = new Map(actualLinks.map(link => {
      const { physicalLinkId, ...facts } = link;
      return [proof(facts), { physicalLinkId, facts }] as const;
    }));
    if (actualByOccurrence.size !== actualLinks.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const ids = new Map<string, string>(), occurrences = new Set<string>();
    for (const link of originalLinks) {
      // This includes raw text, both UTF-16/UTF-8 ranges, syntax, target,
      // source path, fragment, alias and embed; equal spelling alone is not
      // enough to select an occurrence. Fresh Evidence3 reparses actual bytes.
      const { physicalLinkId, ...facts } = link, key = proof(facts), found = actualByOccurrence.get(key);
      if (!found || occurrences.has(key) || !equal(facts, found.facts)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
      occurrences.add(key); ids.set(physicalLinkId, found.physicalLinkId);
    }
    if (ids.size !== originalLinks.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    unchangedPhysicalIds.set(original.path, ids);
  }
  if (before.namespace.length !== after.namespace.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  for (const original of before.namespace) {
    const actual = after.namespace.find(entry => entry.path === original.path), binding = byPath.get(original.path);
    if (!actual || actual.kind !== original.kind || actual.filesystemIdentity !== original.filesystemIdentity
      || actual.workspaceId !== original.workspaceId) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    if (binding) {
      if (actual.documentId !== binding.receipt.target.documentId || actual.lifecycleGeneration !== binding.receipt.target.lifecycleGeneration
        || original.documentId !== null) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    } else if (!equal(actual, original)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    identities.set(original.identity, actual.identity);
  }
  for (const previous of plan.sourceEvidence.nativeComponent.nativeBindings) {
    const actual = current.nativeComponent.nativeBindings.find(item => item.expected.documentId === previous.expected.documentId);
    if (!actual || !equal(actual.expected, previous.expected)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  }
  for (const original of before.edges) {
    const binding = byPath.get(original.source.path);
    const occurrence = binding?.links.find(link => link.physicalLinkId === original.id);
    const candidates = after.edges.filter(edge => edge.source.path === original.source.path && (binding
      ? edge.sourceKind === 'native' && edge.source.documentId === binding.receipt.target.documentId
        && occurrence && equal(edge.ref, occurrence.reference)
      : edge.sourceKind === original.sourceKind && edge.id === (original.sourceKind === 'physical-read'
        ? unchangedPhysicalIds.get(original.source.path)?.get(original.id) : original.id)));
    if (candidates.length !== 1) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const actual = candidates[0]; used.add(actual);
    const anchor = binding ? after.namespace.find(entry => entry.path === original.source.path)!.identity : undefined;
    if (!equal(edgeResolution(original, identities), edgeResolution(actual, new Map(), anchor))) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  }
  for (const edge of after.edges) if (!used.has(edge)) {
    // The physical inventory deliberately omits external/non-file anchors.
    // Such actual imported native edges are retained, never chosen as targets.
    if (!byPath.has(edge.source.path) || edge.classification === 'local'
      || edge.classification === 'anchor-only' && edge.kind === 'wiki') return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  }
}

/** Borrowed, fixed B0 only. Caller owns BEGIN/rollback, the genuine exclusive
 * lifecycle guard, COMMIT confirmation and recovery. This entry returns no
 * claim/admission authority and does not execute the later file action. */
export function prepareWorkspacePathImportsOnConnection(database: SqlConnection, supplied: WorkspacePathImportPreparationInput & { plan: WorkspacePathImportPreparationPlanV1 }): Promise<WorkspacePathImportPreparationRecordV1>;
export function prepareWorkspacePathImportsOnConnection(database: SqlConnection, supplied: WorkspacePathImportPreparationInput & { plan: WorkspacePathHtmlImportPreparationPlanV4 }): Promise<WorkspacePathHtmlImportPreparationRecordV2>;
export function prepareWorkspacePathImportsOnConnection(database: SqlConnection, supplied: WorkspacePathImportPreparationInput): Promise<WorkspacePathImportPreparationRecord>;
export async function prepareWorkspacePathImportsOnConnection(database: SqlConnection, supplied: WorkspacePathImportPreparationInput
): Promise<WorkspacePathImportPreparationRecord> {
  const result = await prepareWorkspacePathImportPhase(database, supplied, 'import-only');
  if ('record' in result) return fail(); return result;
}

/** Atomically prepare original imports, the real header, P0 and admission.
 * The caller owns commit/recovery and must leave its exclusive lease before
 * acquiring the ordinary executable claim or waiting for room drain. */
export async function prepareWorkspacePathImportOperationOnConnection(database: SqlConnection,
  supplied: WorkspacePathImportPreparationInput): Promise<WorkspacePathImportOperationPreparation> {
  const result = await prepareWorkspacePathImportPhase(database, supplied, 'operation');
  if (!('record' in result)) return fail(); return result;
}

async function prepareWorkspacePathImportPhase(database: SqlConnection, supplied: WorkspacePathImportPreparationInput,
  purpose: Frame['purpose']): Promise<WorkspacePathImportPreparationRecord | WorkspacePathImportOperationPreparation> {
  exact(supplied, ['principal', 'operationId', 'plan']);
  const selected = field(supplied, 'principal') as WorkspacePathImportPreparationPrincipal;
  exact(selected, ['kind', 'principal']); const kind = field(selected, 'kind'), principal = field(selected, 'principal');
  if (typeof kind !== 'string' || !['request', 'move', 'delete'].includes(kind)) return fail();
  const operationId = field(supplied, 'operationId');
  if (typeof operationId !== 'string' || !operationId || operationId.length > 512
    || Buffer.from(operationId).toString('utf8') !== operationId || /[\u0000-\u001f\u007f]/u.test(operationId)) return fail();
  const rawPlan = field(supplied, 'plan'), version = field(rawPlan, 'version');
  const plan = version === 4 ? decodeWorkspacePathHtmlImportPreparationPlanV4(rawPlan)
    : decodeWorkspacePathImportPreparationPlanV1(rawPlan);
  if (!authenticatedNativeTextSessionEnabled() || plan.readiness !== 'requires-import-rebinding'
    || !plan.importRequirements.length || kind !== 'request' && plan.request.kind !== kind) return fail('PATH_IMPORT_PREPARATION_NOT_READY');
  const actualRealm = await realm(database);
  // Canonicalize before entering the genuine principal phase, whose own
  // backend/XID/search-path identity must remain unchanged until it returns.
  if (kind === 'request') await database.get("SELECT pg_catalog.set_config('search_path',pg_catalog.quote_ident($1)||', pg_catalog, pg_temp',true)", [actualRealm.schemaName]);
  const execute = async (access: Access): Promise<WorkspacePathImportPreparationRecord | WorkspacePathImportOperationPreparation> => {
    assertAccess(access, plan); await access.assertCurrent(); await assertRelations(database, actualRealm.schemaName);
    const clientId = 'clientId' in access ? access.clientId : null;
    const origin: Origin = Object.freeze({ version: 1, kind: kind === 'request' ? 'request' : 'direct-mcp',
      userId: access.userId, sessionId: access.sessionId, clientId, tool: plan.request.kind,
      scope: captureWorkspaceOperationJobScope(access.workspace), realm: actualRealm });
    const batchId = clientId === null ? createHash('sha256').update(JSON.stringify(['workspace-path-operation-id-v1',
      origin.scope.workspaceId, origin.userId, operationId])).digest('hex') : workspaceOperationMcpBatchId({ userId: access.userId,
      clientId, workspaceId: origin.scope.workspaceId, tool: kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source', operationId });
    const existing = await readWorkspacePathImportPreparationRecordOnConnection(database,
      { schema: actualRealm.schemaName, workspaceId: origin.scope.workspaceId, batchId });
    if (existing) {
      if (existing.operationId !== operationId || existing.previewPlan.planId !== plan.planId
        || !equal(existing.previewPlan.request, plan.request) || !equal(existing.origin.scope, origin.scope)
        || !equal(existing.origin.realm, origin.realm) || existing.origin.kind !== origin.kind
        || existing.origin.userId !== origin.userId || existing.origin.clientId !== clientId || existing.origin.tool !== origin.tool) {
        return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
      }
      if (purpose === 'import-only') { await access.assertCurrent(); return existing; }
      const { readWorkspacePathImportOperationBatchOnConnection } = await import('./workspace-operation-batch-store');
      const batch = await readWorkspacePathImportOperationBatchOnConnection(database, { record: existing, workspace: access.workspace });
      if (!batch) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
      await access.assertCurrent(); return Object.freeze({ record: existing, batch });
    }
    await assertWorkspaceFileLifecycleSourceLeaseCurrent(database, origin.scope.workspaceId);
    await assertWorkspaceFileLifecycleSqlAvailable(database, origin.scope.workspaceId, plan.importRequirements.map(item => item.path));
    const observed = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace, { physicalParserVersion: 3 });
    if (plan.version === 4) assertWorkspacePathHtmlImportPreparationPlanV4Current(plan, observed, origin.scope);
    else assertWorkspacePathImportPreparationPlanV1Current(plan, observed, origin.scope);
    const handle = Object.freeze({}) as WorkspacePathImportPreparationHandle;
    const frame: Frame = { active: true, database, access, identity: await identity(database), origin, operationId,
      plan, nextIndex: 0, bindings: [], purpose }; frames.set(handle, frame);
    try {
      for (let index = 0; index < plan.importRequirements.length; index++) {
        const binding = await persistWorkspacePathOriginalMarkdownImportOnConnection(database, { preparation: handle, requirementIndex: index });
        frame.bindings.push(binding); frame.nextIndex++;
      }
      await assertFrame(database, handle); await assertWorkspacePathImportedOriginalsOnConnection(database, handle);
      const fresh = await readWorkspaceLinkSourceAuthorityOnConnection(database, access.workspace, { physicalParserVersion: 3 });
      if (plan.version === 4) {
        const evidence = captureWorkspaceOperationMixedSourceEvidenceV5(origin.scope, fresh);
        assertWorkspacePathHtmlImportsCurrentGraphV4(plan, frame.bindings, evidence);
        const before = captureWorkspaceOperationNativeCatalogueWitness(observed.privateCatalogue, origin.scope,
          plan.sourceEvidence.nativeComponent.stage.catalogueProof!, plan.sourceEvidence.nativeComponent.nativeBindings, () => fail());
        const current = captureWorkspaceOperationNativeCatalogueWitness(fresh.privateCatalogue, origin.scope,
          evidence.nativeComponent.stage.catalogueProof!, evidence.nativeComponent.nativeBindings, () => fail());
        const bornIds = new Set(frame.bindings.map(binding => binding.receipt.target.documentId));
        if (!equal(before.entries, current.entries.filter(entry => !bornIds.has(entry.id)))) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
      } else {
        const evidence = captureWorkspaceOperationNativeSourceEvidenceV3(origin.scope, fresh);
        assertImportedGraph(plan, frame.bindings, evidence);
      }
      const selections = plan.request.selections.map(selection => ({ sourcePath: selection.sourcePath,
        ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) }));
      const actionId = createHash('sha256').update(JSON.stringify(['workspace-path-action-v1', origin.scope.workspaceId,
        plan.request.kind, selections, false, false])).digest('hex');
      const actions = [{ reviewId: `${actionId}-request`, kind: plan.request.kind,
        selections }];
      const input = { scope: { workspace: access.workspace, fileOptions: { workspace: access.workspace } }, actions, observation: fresh };
      const hasPhysical = fresh.stage.sources.some(source => source.kind === 'physical');
      const nativePlan = plan.version === 4
        ? plan.request.kind === 'delete'
          ? fresh.nativeBindings.some(binding => binding.expected.path === selections[0]?.sourcePath)
            ? createWorkspaceOperationNativeDeleteBatchPlanV4(input) : createWorkspaceOperationPhysicalDeleteBatchPlanV5(input)
          : createWorkspaceOperationNativeMoveBatchPlanV4(input)
        : plan.request.kind === 'delete'
          ? hasPhysical ? createWorkspaceOperationNativeDeleteBatchPlanV3(input) : createWorkspaceOperationNativeDeleteBatchPlan(input)
          : hasPhysical ? createWorkspaceOperationNativeMoveBatchPlanV3(input) : createWorkspaceOperationNativeMoveBatchPlan(input);
      const body = { version: plan.version === 4 ? 2 as const : 1 as const, operationId, batchId, origin, previewPlan: plan,
        imports: frame.bindings.map((binding, requirementIndex) => ({ requirementIndex, receipt: binding.receipt,
          bindingProof: binding.bindingProof, initialBinaryHash: binding.nativeBinaryHash, initialVectorHash: binding.nativeVectorHash,
          ...(plan.version === 4 ? { legacyBinding: binding, ordinaryBinding: captureRawHtmlNativeBindingV1({
            source: plan.sourceBindings[requirementIndex], binding,
            state: fresh.privateNativeStates.find(state => state.documentId === binding.receipt.target.documentId) ?? fail() }) } : {}) })),
        nativePlan, b0TransactionId: frame.identity.xid, preparedAt: Date.now() };
      frame.record = decodeWorkspacePathAnyImportPreparationRecord({ ...body, recordProof: proof(body) });
      await assertWorkspacePathImportRecordPreparationOnConnection(database, handle, frame.record);
      await insertWorkspacePathImportPreparationRecordOnConnection(database, { handle, record: frame.record });
      await assertWorkspacePathImportRecordPreparationOnConnection(database, handle, frame.record);
      if (purpose === 'operation') {
        const { insertWorkspacePathImportOperationBatchOnConnection } = await import('./workspace-operation-batch-store');
        frame.operation = await insertWorkspacePathImportOperationBatchOnConnection(database, handle);
        const { prepareWorkspacePathImportOperationAdmissionOnConnection } = await import('./workspace-operation-native-path-admission');
        frame.admissionRequest = await prepareWorkspacePathImportOperationAdmissionOnConnection(database, handle);
        const { reserveWorkspacePathImportOperationAdmissionOnConnection } = await import('../collaboration/room-admission');
        await reserveWorkspacePathImportOperationAdmissionOnConnection(database, handle);
        await assertWorkspacePathImportRecordPreparationOnConnection(database, handle, frame.record);
      }
      await assertWorkspacePathImportedOriginalsOnConnection(database, handle);
      return purpose === 'operation' ? Object.freeze({ record: frame.record, batch: frame.operation!.batch }) : frame.record;
    } finally { frame.active = false; frames.delete(handle); }
  };
  if (kind === 'request') return withWorkspaceRequestPrincipalOnConnection(database, principal as WorkspaceRequestPrincipal, execute);
  if (kind === 'move') return withDirectMcpWorkspaceMoveOriginalImportPrincipalOnConnection(database, principal as DirectMcpWorkspaceMovePrincipal, execute);
  return withDirectMcpWorkspaceDeleteOriginalImportPrincipalOnConnection(database, principal as DirectMcpWorkspaceDeletePrincipal, execute);
}
