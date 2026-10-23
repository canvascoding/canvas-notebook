import 'server-only';

import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { workspaceOperationJobScopeMatches, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';

type Row = Readonly<Record<string, unknown>>;
export type OriginalPhysicalDeleteRegistryFactsV1 = Readonly<{
  version: 1; kind: 'physical-delete-registry'; workspaceScope: WorkspaceOperationJobScope; sourcePath: string;
  catalogue: Readonly<WorkspaceDocumentCatalogueEntry> | null; registry: Row | null; lineage: Row | null; factsProof: string;
}>;
export type OriginalPhysicalDeleteRegistryReceiptV1 = Readonly<{
  version: 1; kind: 'physical-delete-registry-archived'; original: OriginalPhysicalDeleteRegistryFactsV1;
  trashEntryId: string; archivedAt: number; registry: Row | null; lineage: Row | null; receiptProof: string;
}>;
type ReadInput = Readonly<{ schema: string; workspace: WorkspaceContext; workspaceScope: WorkspaceOperationJobScope;
  sourcePath: string; catalogue: unknown }>;
function fail(): never { throw Object.assign(new Error('ORIGINAL_DELETE_CHANGED'), { code: 'ORIGINAL_DELETE_CHANGED', status: 409 }); }
const number = (value: unknown): boolean => (typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
function freezeRegistryData<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeRegistryData(child);Object.freeze(value);}return value;
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value);
function keys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail();
}
function schema(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 63 || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return `"${value.replaceAll('"', '""')}"`;
}
function scopeRow(row: Row, scope: WorkspaceOperationJobScope, sourcePath: string): void {
  if (!id(row.id) || row.workspace_id !== scope.workspaceId || row.workspace_type !== scope.workspaceType
    || row.organization_id !== scope.organizationId || row.customer_id !== scope.customerId || row.project_id !== scope.projectId
    || row.path !== sourcePath || row.status !== 'active' || !number(row.created_at)) fail();
}
/** Strict detached factual codec only. No SQL, authority or native archive. */
export function captureOriginalPhysicalDeleteRegistryFactsV1(input: unknown): OriginalPhysicalDeleteRegistryFactsV1 {
  const value = captureWorkspaceOperationNativePlanData(input, fail, 131072);
  keys(value, ['version','kind','workspaceScope','sourcePath','catalogue','registry','lineage','factsProof']);
  if (value.version !== 1 || value.kind !== 'physical-delete-registry' || !isCanonicalAdmissionPath(value.sourcePath)) fail();
  const result = value as unknown as OriginalPhysicalDeleteRegistryFactsV1, scope = parseWorkspaceOperationJobScope(result.workspaceScope);
  for (const row of [result.registry,result.lineage,result.catalogue]) if (row !== null && (!row || typeof row !== 'object' || Object.getPrototypeOf(row) !== Object.prototype || Array.isArray(row))) fail();
  if (!scope || scope.legacy !== false || !id(scope.workspaceId)) fail();
  if (result.registry) {
    const row = result.registry, catalogue = result.catalogue;
    scopeRow(row, scope, result.sourcePath);
    if (row.provider !== 'yjs' || row.yjs_state_lifecycle !== 'never_initialized' || Number(row.state_version) !== 0
      || !number(row.state_version) || !number(row.updated_at) || row.snapshot_revision_id !== null && !id(row.snapshot_revision_id)
      || !catalogue || catalogue.id !== row.id || catalogue.lineage_id !== row.lineage_id
      || catalogue.path !== result.sourcePath || catalogue.workspace_id !== scope.workspaceId
      || catalogue.organization_id !== scope.organizationId || catalogue.status !== 'active' || catalogue.state_version !== 0
      || catalogue.authority !== 'pristine' || catalogue.yjs_state_lifecycle !== 'never_initialized'
      || catalogue.has_persisted_state !== false || catalogue.has_state_history !== false || catalogue.lifecycle_generation !== null
      || catalogue.state_status !== null || catalogue.state_path !== null || catalogue.state_workspace_id !== null
      || catalogue.state_organization_id !== null || (row.lineage_id === null ? result.lineage !== null : result.lineage?.id !== row.lineage_id)) fail();
    captureWorkspaceOperationNativeCatalogueWitness([catalogue],scope,proof([catalogue]),[],fail);
  } else if (result.catalogue !== null) fail();
  if (result.lineage) {
    scopeRow(result.lineage, scope, result.sourcePath);
    if (result.lineage.archived_at !== null || result.lineage.trash_entry_id !== null) fail();
  }
  const { factsProof, ...body } = result;
  if (factsProof !== proof(body)) fail();
  return freezeRegistryData(result);
}
/** Actual B-only row reader. The caller's owner/ACL/FD checks remain required. */
export async function readOriginalPhysicalDeleteRegistryOnConnectionV1(database: SqlConnection,
  input: ReadInput): Promise<OriginalPhysicalDeleteRegistryFactsV1> {
  const selected = captureWorkspaceOperationNativePlanData({ workspaceScope: input.workspaceScope, sourcePath: input.sourcePath, catalogue: input.catalogue }, fail, 16 * 1024 * 1024) as Pick<ReadInput,'workspaceScope'|'sourcePath'|'catalogue'>;
  if (!workspaceOperationJobScopeMatches(selected.workspaceScope, input.workspace) || selected.workspaceScope.legacy
    || !isCanonicalAdmissionPath(selected.sourcePath) || !Array.isArray(selected.catalogue)) fail();
  const prefix = schema(input.schema), values = [selected.workspaceScope.workspaceId, selected.sourcePath];
  const registries = await database.all(`SELECT pg_catalog.to_jsonb(d) AS row FROM ${prefix}.collaboration_documents d
    WHERE workspace_id=$1 AND path=$2 AND status='active' ORDER BY id LIMIT 2 FOR UPDATE NOWAIT`, values) as Array<{ row: Row }>;
  const lineages = await database.all(`SELECT pg_catalog.to_jsonb(l) AS row FROM ${prefix}.file_collaboration_lineages l
    WHERE workspace_id=$1 AND path=$2 AND status='active' ORDER BY id LIMIT 2 FOR UPDATE NOWAIT`, values) as Array<{ row: Row }>;
  if (registries.length > 1 || lineages.length > 1 || await database.get(`SELECT document_id FROM ${prefix}.collaboration_yjs_states
    WHERE workspace_id=$1 AND path=$2 AND status='active' LIMIT 1 FOR SHARE NOWAIT`, values)) fail();
  const registry = registries[0]?.row ?? null, lineage = lineages[0]?.row ?? null;
  const catalogue = selected.catalogue.filter(row => row.path === selected.sourcePath);
  if (catalogue.length > 1 || Boolean(registry) !== Boolean(catalogue.length)) fail();
  if (registry) for (const table of ['collaboration_yjs_states','collaboration_yjs_state_backups','collaboration_agent_operations','collaboration_file_projections']) {
    if (await database.get(`SELECT document_id FROM ${prefix}.${table} WHERE document_id=$1 LIMIT 1 FOR SHARE NOWAIT`, [registry.id])) fail();
  }
  const body = { version: 1 as const, kind: 'physical-delete-registry' as const, workspaceScope: selected.workspaceScope,
    sourcePath: selected.sourcePath, catalogue: catalogue[0] ?? null, registry, lineage };
  return captureOriginalPhysicalDeleteRegistryFactsV1({ ...body, factsProof: proof(body) });
}
export async function assertOriginalPhysicalDeleteRegistryCurrentOnConnectionV1(database: SqlConnection,
  input: ReadInput, expected: OriginalPhysicalDeleteRegistryFactsV1): Promise<void> {
  const captured = captureOriginalPhysicalDeleteRegistryFactsV1(expected);
  if (!equal(await readOriginalPhysicalDeleteRegistryOnConnectionV1(database, input), captured)) fail();
}
/** Receipt codec has no native D/L generation transition. Original pristine
 * IDs and never_initialized state are preserved as exact archived rows. */
export function assertOriginalPhysicalDeleteRegistryReceiptV1(input: unknown,
  original: OriginalPhysicalDeleteRegistryFactsV1, trashEntryId: string, archivedAt: number): asserts input is OriginalPhysicalDeleteRegistryReceiptV1 {
  const value = captureWorkspaceOperationNativePlanData(input, fail, 262144);
  keys(value, ['version','kind','original','trashEntryId','archivedAt','registry','lineage','receiptProof']);
  const captured = captureOriginalPhysicalDeleteRegistryFactsV1(original);
  const expectedRegistry = captured.registry ? { ...captured.registry, status: 'archived', state_version: 0,
    snapshot_revision_id: null, updated_at: archivedAt } : null;
  const expectedLineage = captured.lineage ? { ...captured.lineage, status: 'archived', archived_at: archivedAt, trash_entry_id: trashEntryId } : null;
  const { receiptProof, ...body } = value;
  if (value.version !== 1 || value.kind !== 'physical-delete-registry-archived' || !equal(value.original, captured)
    || !/^trash-[0-9a-f-]{36}$/u.test(trashEntryId) || !number(archivedAt) || typeof archivedAt !== 'number'
    || value.trashEntryId !== trashEntryId || value.archivedAt !== archivedAt
    || !equal(value.registry, expectedRegistry) || !equal(value.lineage, expectedLineage) || receiptProof !== proof(body)) fail();
}
export async function archiveOriginalPhysicalDeleteRegistryOnConnectionV1(database: SqlConnection,
  input: ReadInput & Readonly<{ expected: OriginalPhysicalDeleteRegistryFactsV1; trashEntryId: string; archivedAt: number }>
): Promise<OriginalPhysicalDeleteRegistryReceiptV1> {
  const expected = captureOriginalPhysicalDeleteRegistryFactsV1(input.expected), prefix = schema(input.schema);
  await assertOriginalPhysicalDeleteRegistryCurrentOnConnectionV1(database, input, expected);
  if (!/^trash-[0-9a-f-]{36}$/u.test(input.trashEntryId) || typeof input.archivedAt !== 'number' || !number(input.archivedAt)) fail();
  let registry: Row | null = null, lineage: Row | null = null;
  if (expected.registry) {
    const changed = await database.get(`UPDATE ${prefix}.collaboration_documents d SET status='archived',state_version=0,
      snapshot_revision_id=NULL,updated_at=$1 WHERE id=$2 AND pg_catalog.to_jsonb(d)=$3::jsonb
      RETURNING pg_catalog.to_jsonb(d) AS row`, [input.archivedAt, expected.registry.id, JSON.stringify(expected.registry)]) as { row: Row } | undefined;
    if (!changed) fail(); registry = changed.row;
  }
  if (expected.lineage) {
    const changed = await database.get(`UPDATE ${prefix}.file_collaboration_lineages l SET status='archived',archived_at=$1,trash_entry_id=$2
      WHERE id=$3 AND pg_catalog.to_jsonb(l)=$4::jsonb RETURNING pg_catalog.to_jsonb(l) AS row`,
    [input.archivedAt, input.trashEntryId, expected.lineage.id, JSON.stringify(expected.lineage)]) as { row: Row } | undefined;
    if (!changed) fail(); lineage = changed.row;
  }
  const body = { version: 1 as const, kind: 'physical-delete-registry-archived' as const, original: expected,
    trashEntryId: input.trashEntryId, archivedAt: input.archivedAt, registry, lineage };
  const result = { ...body, receiptProof: proof(body) };
  assertOriginalPhysicalDeleteRegistryReceiptV1(result, expected, input.trashEntryId, input.archivedAt);
  const values = [input.workspace.workspaceId,input.sourcePath];
  for (const table of ['collaboration_documents','file_collaboration_lineages','collaboration_yjs_states']) {
    if (await database.get(`SELECT 1 AS present FROM ${prefix}.${table} WHERE workspace_id=$1 AND path=$2
      AND status='active' LIMIT 1 FOR SHARE NOWAIT`, values)) fail();
  }
  for (const [table, row] of [['collaboration_documents',registry],['file_collaboration_lineages',lineage]] as const) {
    if (row) {
      const reread = await database.get(`SELECT pg_catalog.to_jsonb(t) AS row FROM ${prefix}.${table} t WHERE id=$1 FOR SHARE NOWAIT`, [row.id]) as { row: Row } | undefined;
      if (!reread || !equal(reread.row,row)) fail();
    }
  }
  return freezeRegistryData(result);
}
