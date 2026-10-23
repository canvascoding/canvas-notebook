import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import { captureWorkspaceOperationNativeCatalogueWitness } from './workspace-operation-native-catalogue-witness';
import { decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import { workspaceOperationSourceNativeEvidence } from './workspace-operation-mixed-source-evidence';
import type { WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import type { WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import type { WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../db/native-file-operation-side-effects-migration';
import { withCollaborationAdmissionMutation } from '../collaboration/room-admission-handoff';
import { readWorkspacePathSideEffectRowsOnConnection } from '../markdown/native-file-operation-side-effects';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { workspaceOperationOriginalMoveNamespaceEffects,
  type WorkspaceOperationOriginalMoveContext, type WorkspaceOperationOriginalMoveIntentData } from './workspace-operation-original-move';

type Row = Record<string, unknown>;
type Rows = Awaited<ReturnType<typeof readWorkspacePathSideEffectRowsOnConnection>>;
export type WorkspaceOperationOriginalMoveNamespaceStage = Readonly<{
  version: 1; batchId: string; planId: string; workspaceId: string; organizationId: string | null;
  requestHash: string; actor: WorkspaceOperationOriginalMoveContext['actor']; schema: string;
  effectsProof: string; beforeRows: Rows; lineages: readonly Row[];
}>;
export type WorkspaceOperationOriginalMoveNamespaceReceipt = Readonly<{
  version: 1; batchId: string; planId: string; workspaceId: string; effectsProof: string;
  stageDigest: string; appliedAt: number; afterRowsProof: string; rowCounts: Record<string, number>;
}>;
export type WorkspaceOperationOriginalMoveNamespaceState = Readonly<{ stageText: string; stageDigest: string }>;
type CatalogueWitness = WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5;
export type WorkspaceOperationOriginalMovePristineRegistryRow = Readonly<{
  id: string; organization_id: string | null; customer_id: string | null; project_id: string | null;
  workspace_id: string; workspace_type: string; path: string; lineage_id: string; provider: 'yjs';
  state_version: 0; yjs_state_lifecycle: 'never_initialized'; snapshot_revision_id: string | null;
  status: 'active'; created_at: number; updated_at: number;
}>;
export type WorkspaceOperationOriginalMovePristineRegistryRecord = Readonly<{
  catalogue: Readonly<WorkspaceDocumentCatalogueEntry>; registry: WorkspaceOperationOriginalMovePristineRegistryRow;
}>;
export type WorkspaceOperationOriginalMoveNamespaceStageV2 = Omit<WorkspaceOperationOriginalMoveNamespaceStage, 'version'> & Readonly<{
  version: 2; catalogueBinding: Readonly<{ catalogueProof: string; semanticCatalogueProof: string; evidenceProof: string }>;
  pristineRegistry: readonly WorkspaceOperationOriginalMovePristineRegistryRecord[];
}>;
export type AnyWorkspaceOperationOriginalMoveNamespaceStage = WorkspaceOperationOriginalMoveNamespaceStage | WorkspaceOperationOriginalMoveNamespaceStageV2;
export type WorkspaceOperationOriginalMoveNamespaceReceiptV2 = Omit<WorkspaceOperationOriginalMoveNamespaceReceipt, 'version'> & { version: 2 };
export type AnyWorkspaceOperationOriginalMoveNamespaceReceipt = WorkspaceOperationOriginalMoveNamespaceReceipt | WorkspaceOperationOriginalMoveNamespaceReceiptV2;
export type WorkspaceOperationOriginalMovePristineRegistryFacts = Readonly<{
  documentId: string; lineageId: string; sourcePath: string; destinationPath: string;
  catalogueBefore: Readonly<WorkspaceDocumentCatalogueEntry>; catalogueAfter: Readonly<WorkspaceDocumentCatalogueEntry>;
  registryBefore: WorkspaceOperationOriginalMovePristineRegistryRow; registryAfter: WorkspaceOperationOriginalMovePristineRegistryRow;
  lineageBefore: Readonly<Row>; lineageAfter: Readonly<Row>;
}>;

const keys = ['metadata', 'userStates', 'guests', 'publicShares', 'locks'] as const;
const MiB = 1024 * 1024;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const table = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`;
const registryKeys = ['id','organization_id','customer_id','project_id','workspace_id','workspace_type','path','lineage_id','provider','state_version','yjs_state_lifecycle','snapshot_revision_id','status','created_at','updated_at'];
const catalogueKeys = ['id','lineage_id','path','workspace_id','organization_id','status','state_version','yjs_state_lifecycle','has_persisted_state','has_state_history','lifecycle_generation','authority','state_status','state_path','state_workspace_id','state_organization_id'];
const lineageKeys = ['id','organization_id','customer_id','project_id','workspace_id','workspace_type','path','status','created_at','archived_at','trash_entry_id'];
export class WorkspaceOperationOriginalMoveNamespaceError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_MOVE_NAMESPACE_INVALID' | 'ORIGINAL_MOVE_NAMESPACE_CHANGED'
    | 'ORIGINAL_MOVE_NAMESPACE_BUSY' | 'ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED') { super(code); this.name = 'WorkspaceOperationOriginalMoveNamespaceError'; }
}
function fail(code: WorkspaceOperationOriginalMoveNamespaceError['code'] = 'ORIGINAL_MOVE_NAMESPACE_INVALID'): never {
  throw new WorkspaceOperationOriginalMoveNamespaceError(code);
}
function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => Array.isArray(item) ? item.map(visit)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Row)[key])])) : item;
  return JSON.stringify(visit(value));
}
function exact(value: unknown, names: readonly string[]): Row {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length) fail();
  for (const name of names) { const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) fail(); }
  return value as Row;
}
function text(value: unknown, max = 256, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || !value.length
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) fail();
}
function clock(value: unknown, minimum = 0, nullable = false): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value >= Number.MAX_SAFE_INTEGER) fail();
}
function proof(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function parse(value: unknown, maximum: number): Row {
  if (typeof value !== 'string' || value.length > maximum || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString('utf8') !== value || value.includes('\0')) fail();
  let result: unknown; try { result = JSON.parse(value); } catch { return fail(); }
  if (!result || Object.getPrototypeOf(result) !== Object.prototype) fail();
  // Only bounded JSON supplied as text enters these decoders; never caller getters/toJSON.
  if (canonical(result) !== value) fail();
  return result as Row;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
function planPaths(context: WorkspaceOperationOriginalMoveContext) {
  const effects = workspaceOperationOriginalMoveNamespaceEffects(context);
  return { effects, sources: effects.map(effect => effect.sourcePath), destinations: effects.map(effect => effect.destinationPath),
    known: [...new Set(context.plan.nativePathPlan.pathMappings.flatMap(mapping => [mapping.source.path, mapping.destinationPath]))] };
}
type NamespaceSelectedPaths = Readonly<{ sources: readonly string[]; destinations: readonly string[] }>;
function rows(value: unknown, context: WorkspaceOperationOriginalMoveContext, paths: NamespaceSelectedPaths): Rows {
  const row = exact(value, keys), allowed = new Set([...paths.sources,...paths.destinations]);
  let count = 0;
  const base: Record<string, string[]> = {
    metadata: ['workspaceId','path','title','createdAt','updatedAt'],
    userStates: ['workspaceId','userId','path','isFavorite','pinnedAt','createdAt','updatedAt'],
    publicShares: ['id','workspaceId','organizationId','path','status','policyRevision','revokedAt','revokedReason','updatedAt','preservedRowProof'],
    locks: ['id','workspaceId','organizationId','path','lineageId','revisionId','lockedByUserId','lockedBySessionId','lockType','status','expiresAt','createdAt','updatedAt','preservedRowProof'],
  };
  for (const key of keys) {
    const list = row[key]; if (!Array.isArray(list) || list.length > 256 || (count += list.length) > 2048) fail();
    if (key === 'guests' && list.length) fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
    const seen = new Set<string>();
    for (const entry of list) {
      const item = exact(entry, base[key]);
      if (item.workspaceId !== context.plan.workspaceId || typeof item.path !== 'string' || !allowed.has(item.path)) fail();
      if (key === 'metadata') { if (item.title !== null && (typeof item.title !== 'string' || Buffer.byteLength(item.title) > 640)) fail(); }
      if (key === 'userStates') { text(item.userId); if (typeof item.isFavorite !== 'boolean') fail(); clock(item.pinnedAt, 0, true); }
      for (const name of ['createdAt','updatedAt'] as const) if (Object.hasOwn(item, name)) clock(item[name]);
      if (key === 'publicShares' || key === 'locks') {
        text(item.id); text(item.organizationId,256,true); proof(item.preservedRowProof);
        if (item.organizationId !== context.plan.sourceEvidence.workspaceScope.organizationId || item.status !== 'active') fail();
      }
      if (key === 'publicShares') { clock(item.policyRevision,1); if ((item.policyRevision as number) >= Number.MAX_SAFE_INTEGER-1) fail();
        clock(item.revokedAt,0,true); text(item.revokedReason,4096,true); }
      if (key === 'locks') { for (const name of ['lineageId','revisionId','lockedByUserId','lockedBySessionId']) text(item[name],256,true);
        if (!['edit','upload','agent_write'].includes(String(item.lockType))) fail(); clock(item.expiresAt); }
      const identity = key === 'metadata' ? item.path : key === 'userStates' ? `${item.path}\0${item.userId}` : item.id;
      if (seen.has(String(identity))) fail(); seen.add(String(identity));
    }
  }
  return row as Rows;
}
function lineageRows(value: unknown, context: WorkspaceOperationOriginalMoveContext, sourcePaths: readonly string[]): readonly Row[] {
  if (!Array.isArray(value) || value.length > 256) fail();
  const sources = new Set(sourcePaths), ids = new Set<string>(), paths = new Set<string>();
  for (const raw of value) {
    const row = exact(raw,lineageKeys);
    for (const name of ['id','workspace_id','workspace_type']) text(row[name]);
    for (const name of ['organization_id','customer_id','project_id','trash_entry_id']) text(row[name],256,true);
    clock(row.created_at); clock(row.archived_at,0,true);
    if (row.workspace_id !== context.plan.workspaceId || row.workspace_type !== context.plan.sourceEvidence.workspaceScope.workspaceType
      || row.organization_id !== context.plan.sourceEvidence.workspaceScope.organizationId || row.status !== 'active'
      || row.archived_at !== null || typeof row.path !== 'string' || !sources.has(row.path)
      || ids.has(String(row.id)) || paths.has(row.path)) fail();
    ids.add(String(row.id)); paths.add(row.path);
  }
  return value as Row[];
}
export function decodeWorkspaceOperationOriginalMoveNamespaceStage(stageText: string,
  context: WorkspaceOperationOriginalMoveContext, currentWitness?: unknown): AnyWorkspaceOperationOriginalMoveNamespaceStage {
  const parsed = parse(stageText,MiB);
  if (parsed.version === 2) return decodePristineStage(parsed, context, currentWitness);
  const paths = planPaths(context), effects = paths.effects;
  const row = exact(parsed,['version','batchId','planId','workspaceId','organizationId','requestHash','actor','schema','effectsProof','beforeRows','lineages']);
  if (row.version !== 1 || row.batchId !== context.batchId || row.planId !== context.plan.planId || row.workspaceId !== context.plan.workspaceId
    || row.organizationId !== context.plan.sourceEvidence.workspaceScope.organizationId || row.requestHash !== context.requestHash
    || !equal(row.actor,context.actor) || row.effectsProof !== nativeLinkJsonProof(effects) || !effects.length) fail();
  text(row.schema,63); rows(row.beforeRows,context,paths); lineageRows(row.lineages,context,paths.sources);
  const sourcePaths = new Set(paths.sources);
  const beforeRows = row.beforeRows as Rows;
  for (const key of ['metadata','userStates','publicShares'] as const) {
    if (beforeRows[key].some(item => !sourcePaths.has(String(item.path)))) fail();
  }
  return freeze(row) as WorkspaceOperationOriginalMoveNamespaceStage;
}
function boundCatalogueWitness(context: WorkspaceOperationOriginalMoveContext, input: unknown) {
  const expected = context.plan.sourceEvidence;
  if (expected.evidenceVersion === 1) fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
  let witness: CatalogueWitness;
  try { witness = decodeWorkspaceOperationMixedOriginalSourceWitness(expected, input); }
  catch { return fail(); }
  const native = workspaceOperationSourceNativeEvidence(witness);
  if (native.evidenceVersion === 1) return fail();
  return { witness, native, binding: { catalogueProof: native.stage.catalogueProof!,
    semanticCatalogueProof: native.semanticCatalogueProof, evidenceProof: witness.evidenceProof } };
}
function pristineRecord(input: unknown, context: WorkspaceOperationOriginalMoveContext,
  lineages: readonly Row[], paths: NamespaceSelectedPaths): WorkspaceOperationOriginalMovePristineRegistryRecord {
  const pair = exact(input, ['catalogue', 'registry']), catalogue = exact(pair.catalogue, catalogueKeys), registry = exact(pair.registry, registryKeys);
  const scope = context.plan.sourceEvidence.workspaceScope;
  for (const name of ['id','workspace_id','workspace_type','lineage_id'] as const) text(registry[name]);
  for (const name of ['organization_id','customer_id','project_id','snapshot_revision_id'] as const) text(registry[name],256,true);
  clock(registry.created_at); clock(registry.updated_at);
  if (registry.workspace_id !== scope.workspaceId || registry.organization_id !== scope.organizationId
    || registry.customer_id !== scope.customerId || registry.project_id !== scope.projectId || registry.workspace_type !== scope.workspaceType
    || registry.provider !== 'yjs' || registry.status !== 'active' || registry.yjs_state_lifecycle !== 'never_initialized' || registry.state_version !== 0
    || typeof registry.path !== 'string' || !paths.sources.includes(registry.path) || paths.destinations.includes(registry.path)
    || !context.plan.nativePathPlan.pathMappings.some(mapping => mapping.source.path === registry.path && mapping.source.kind === 'file'
      && mapping.source.documentId === null && mapping.source.lifecycleGeneration === null && mapping.source.filesystemIdentity !== null)
    || catalogue.id !== registry.id || catalogue.lineage_id !== registry.lineage_id || catalogue.path !== registry.path
    || catalogue.workspace_id !== registry.workspace_id || catalogue.organization_id !== registry.organization_id
    || catalogue.status !== 'active' || catalogue.state_version !== 0 || catalogue.yjs_state_lifecycle !== 'never_initialized'
    || catalogue.authority !== 'pristine' || catalogue.has_persisted_state !== false || catalogue.has_state_history !== false
    || ['lifecycle_generation','state_status','state_path','state_workspace_id','state_organization_id'].some(key => catalogue[key] !== null)) fail();
  const lineage = lineages.find(row => row.id === registry.lineage_id);
  if (!lineage || lineage.path !== registry.path || lineage.workspace_id !== registry.workspace_id
    || lineage.workspace_type !== registry.workspace_type || lineage.organization_id !== registry.organization_id
    || lineage.customer_id !== registry.customer_id || lineage.project_id !== registry.project_id
    || lineage.status !== 'active' || lineage.archived_at !== null || lineage.trash_entry_id !== null) fail();
  return input as WorkspaceOperationOriginalMovePristineRegistryRecord;
}
function decodePristineStage(parsed: Row, context: WorkspaceOperationOriginalMoveContext,
  currentWitness: unknown): WorkspaceOperationOriginalMoveNamespaceStageV2 {
  const row = exact(parsed, ['version','batchId','planId','workspaceId','organizationId','requestHash','actor','schema','effectsProof','beforeRows','lineages',
    'catalogueBinding','pristineRegistry']);
  const { catalogueBinding: _binding, pristineRegistry: _pristine, ...common } = row;
  // Preserve and reuse the exact historical common-field decoder. This local
  // comparison value is not a saved Stage1 record or a relabelled source fact.
  decodeWorkspaceOperationOriginalMoveNamespaceStage(canonical({ ...common, version: 1 }), context);
  const bound = boundCatalogueWitness(context, currentWitness);
  if (!equal(exact(row.catalogueBinding,['catalogueProof','semanticCatalogueProof','evidenceProof']), bound.binding)
    || !Array.isArray(row.pristineRegistry) || row.pristineRegistry.length < 1 || row.pristineRegistry.length > 256) fail();
  const ids = new Set<string>(), paths = new Set<string>(), lineageIds = new Set<string>();
  let priorId = '';
  const selectedPaths = planPaths(context);
  for (const input of row.pristineRegistry) {
    const pair = pristineRecord(input, context, row.lineages as Row[], selectedPaths), registry = pair.registry;
    if (ids.has(registry.id) || paths.has(registry.path) || lineageIds.has(registry.lineage_id)
      || priorId && Buffer.compare(Buffer.from(priorId), Buffer.from(registry.id)) >= 0) fail();
    ids.add(registry.id); paths.add(registry.path); lineageIds.add(registry.lineage_id); priorId = registry.id;
  }
  return freeze(row) as WorkspaceOperationOriginalMoveNamespaceStageV2;
}
function pristineAbsenceSql(schema: string, alias: string): string {
  return `NOT EXISTS(SELECT 1 FROM ${table(schema,'collaboration_yjs_states')} s WHERE s.document_id=${alias}.id)
    AND NOT EXISTS(SELECT 1 FROM ${table(schema,'collaboration_yjs_state_backups')} b WHERE b.document_id=${alias}.id)
    AND NOT EXISTS(SELECT 1 FROM ${table(schema,'collaboration_agent_operations')} a WHERE a.document_id=${alias}.id)
    AND NOT EXISTS(SELECT 1 FROM ${table(schema,'collaboration_file_projections')} p WHERE p.document_id=${alias}.id)`;
}
async function readPristineRegistryRows(database: SqlConnection, schema: string, context: WorkspaceOperationOriginalMoveContext,
  ids?: readonly string[]): Promise<WorkspaceOperationOriginalMovePristineRegistryRow[]> {
  const paths = planPaths(context), scope = ids ? [...ids] : [...paths.sources,...paths.destinations];
  const selected = await database.all(`SELECT CASE WHEN ${registryKeys.filter(key => !['state_version','created_at','updated_at'].includes(key))
    .map(key => `(d.${key} IS NULL OR octet_length(d.${key})<=${key === 'path' ? 4096 : 256})`).join(' AND ')} THEN to_jsonb(d) ELSE NULL END AS row_json,
      (d.provider='yjs' AND d.yjs_state_lifecycle='never_initialized' AND d.state_version=0 AND ${pristineAbsenceSql(schema,'d')}) AS pristine
    FROM ${table(schema,'collaboration_documents')} d WHERE d.workspace_id=$1 AND ${ids ? 'd.id' : 'd.path'}=ANY($2::text[])
      AND d.status='active' ORDER BY d.id COLLATE "C" LIMIT 257 FOR UPDATE`,[context.plan.workspaceId,scope]) as Array<{row_json:Row|null;pristine:boolean}>;
  if (selected.length > 256) fail();
  for (const row of selected) if (!row.row_json || row.pristine !== true) fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
  return selected.map(row => row.row_json as WorkspaceOperationOriginalMovePristineRegistryRow);
}
async function capturePristineRegistry(database: SqlConnection, input: {
  schema: string; workspace: WorkspaceContext; context: WorkspaceOperationOriginalMoveContext;
  observation?: WorkspaceLinkSourceAuthorityObservation; currentWitness?: unknown;
}) {
  const {context,workspace,schema,observation} = input, bound = boundCatalogueWitness(context,input.currentWitness);
  if (!observation || observation.stage.catalogueProof !== bound.binding.catalogueProof
    || !equal(observation.nativeBindings,bound.native.nativeBindings)) fail();
  // Independently read the whole genuine catalogue on this B. Its strict
  // witness is transient: a selected subset never substitutes for this proof.
  const catalogue = await readWorkspaceDocumentCatalogue(database,workspace,{maxEntries:10_000});
  const witness = captureWorkspaceOperationNativeCatalogueWitness(catalogue,bound.witness.workspaceScope,
    bound.binding.catalogueProof,bound.native.nativeBindings,()=>fail());
  if (witness.semanticCatalogueProof !== bound.binding.semanticCatalogueProof || !equal(catalogue,observation.privateCatalogue)) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  const registry = await readPristineRegistryRows(database,schema,context);
  if (!registry.length) fail();
  const records = registry.map(row => {
    const entry = witness.entries.find(entry => entry.id === row.id);
    if (!entry || entry.authority !== 'pristine') return fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
    return { catalogue: entry, registry: row };
  });
  return { binding: bound.binding, records };
}

/** Strict historical facts only. The caller still needs its genuine current
 * owner, immutable journal/receipt and complete fresh catalogue comparison. */
export function getWorkspaceOperationOriginalMovePristineRegistryFacts(input: {
  context: WorkspaceOperationOriginalMoveContext; intent: WorkspaceOperationOriginalMoveIntentData;
  namespaceReceipt: Readonly<{ effectsProof: string; receiptDigest: string; receiptText: string }>;
}): readonly WorkspaceOperationOriginalMovePristineRegistryFacts[] {
  const {context,intent,namespaceReceipt} = input;
  if (intent.batchId !== context.batchId || intent.planId !== context.plan.planId || intent.requestHash !== context.requestHash
    || !equal(intent.actor,context.actor) || !intent.namespaceState || !equal(intent.namespaceEffects,planPaths(context).effects)) fail();
  const witness = intent.version === 1 ? undefined : intent.currentWitness;
  const stage = decodeWorkspaceOperationOriginalMoveNamespaceStage(intent.namespaceState.stageText,context,witness);
  const receipt = decodeWorkspaceOperationOriginalMoveNamespaceReceipt(namespaceReceipt.receiptText,context,intent.namespaceState,witness);
  if (sha(namespaceReceipt.receiptText) !== namespaceReceipt.receiptDigest || namespaceReceipt.effectsProof !== stage.effectsProof) fail();
  if (stage.version === 1) return Object.freeze([]);
  if (receipt.version !== 2) return fail();
  const next = after(stage,context,receipt.appliedAt);
  if (!next.pristineRegistry) return fail();
  const effects = planPaths(context).effects;
  return freeze(stage.pristineRegistry.map((record,index) => {
    const target = effects.find(effect => effect.sourcePath === record.registry.path)!, lineage = stage.lineages.find(row => row.id === record.registry.lineage_id)!;
    return { documentId: record.registry.id, lineageId: record.registry.lineage_id, sourcePath: record.registry.path, destinationPath: target.destinationPath,
      catalogueBefore: record.catalogue, catalogueAfter: next.pristineRegistry![index].catalogue,
      registryBefore: record.registry, registryAfter: next.pristineRegistry![index].registry,
      lineageBefore: lineage, lineageAfter: { ...lineage, path: target.destinationPath } };
  }));
}

function after(stage: AnyWorkspaceOperationOriginalMoveNamespaceStage, context: WorkspaceOperationOriginalMoveContext, at: number): {
  rows: Rows; lineages: Row[]; pristineRegistry?: WorkspaceOperationOriginalMovePristineRegistryRecord[];
} {
  const mapping = new Map(planPaths(context).effects.map(effect => [effect.sourcePath,effect.destinationPath]));
  const result = structuredClone(stage.beforeRows);
  for (const key of ['metadata','userStates'] as const) result[key] = result[key].map<Row>(row => ({...row,path:mapping.get(String(row.path))!}))
    .sort((left,right) => Buffer.compare(Buffer.from(`${left.path}${key === 'userStates' ? `\u001f${left.userId}` : ''}`),
      Buffer.from(`${right.path}${key === 'userStates' ? `\u001f${right.userId}` : ''}`)));
  result.publicShares = result.publicShares.map(row => ({...row,status:'revoked',policyRevision:Number(row.policyRevision)+1,
    revokedAt:at,revokedReason:'target_moved',updatedAt:at}));
  result.locks = result.locks.map(row => ({...row,path:Number(row.expiresAt)>at ? mapping.get(String(row.path))! : row.path,
    status:Number(row.expiresAt)>at ? 'active':'expired',updatedAt:at}));
  const lineages: Row[] = stage.lineages.map(row => ({...row,path:mapping.get(String(row.path))!}));
  if (stage.version === 2) return { rows: result, lineages, pristineRegistry: stage.pristineRegistry.map(item => ({
    catalogue: { ...item.catalogue, path: mapping.get(item.registry.path)! },
    registry: { ...item.registry, path: mapping.get(item.registry.path)! },
  })) };
  return {rows:result,lineages};
}
export function decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receiptText: string, context: WorkspaceOperationOriginalMoveContext,
  state: WorkspaceOperationOriginalMoveNamespaceState, currentWitness?: unknown): AnyWorkspaceOperationOriginalMoveNamespaceReceipt {
  const stage = decodeWorkspaceOperationOriginalMoveNamespaceStage(state.stageText,context,currentWitness);
  proof(state.stageDigest); if (sha(state.stageText) !== state.stageDigest) fail();
  const row = exact(parse(receiptText,16384),['version','batchId','planId','workspaceId','effectsProof','stageDigest','appliedAt','afterRowsProof','rowCounts']);
  if (row.version !== stage.version || row.batchId !== context.batchId || row.planId !== context.plan.planId || row.workspaceId !== context.plan.workspaceId
    || row.effectsProof !== stage.effectsProof || row.stageDigest !== state.stageDigest) fail();
  clock(row.appliedAt); validateBefore(stage,context,row.appliedAt as number);
  const expected = after(stage,context,row.appliedAt as number);
  if (row.afterRowsProof !== nativeLinkJsonProof(expected) || !equal(row.rowCounts,
    Object.fromEntries([...keys.map(key => [key,stage.beforeRows[key].length]),['lineages',stage.lineages.length],
      ...(stage.version === 2 ? [['pristineRegistry', stage.pristineRegistry.length]] : [])]))) fail();
  return freeze(row) as AnyWorkspaceOperationOriginalMoveNamespaceReceipt;
}
async function readLineages(database: SqlConnection, schema: string, context: WorkspaceOperationOriginalMoveContext,
  pristineRegistry?: readonly WorkspaceOperationOriginalMovePristineRegistryRecord[]): Promise<Row[]> {
  const {sources,destinations,known} = planPaths(context), paths = [...sources,...destinations];
  if (pristineRegistry) {
    const current = await readPristineRegistryRows(database, schema, context);
    if (!equal(current, pristineRegistry.map(item => item.registry))) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  } else if (await database.get(`SELECT 1 AS found FROM ${table(schema,'collaboration_documents')} WHERE workspace_id=$1
    AND path=ANY($2::text[]) AND status='active' LIMIT 1`,[context.plan.workspaceId,paths])) fail('ORIGINAL_MOVE_NAMESPACE_UNSUPPORTED');
  const selected = await database.all(`SELECT CASE WHEN octet_length(id)<=256 AND octet_length(path)<=4096
    AND octet_length(workspace_id)<=256 AND octet_length(workspace_type)<=64
    AND (organization_id IS NULL OR octet_length(organization_id)<=256)
    AND (customer_id IS NULL OR octet_length(customer_id)<=256) AND (project_id IS NULL OR octet_length(project_id)<=256)
    AND (trash_entry_id IS NULL OR octet_length(trash_entry_id)<=256) THEN to_jsonb(l) ELSE NULL END AS row_json
    FROM ${table(schema,'file_collaboration_lineages')} l WHERE workspace_id=$1 AND path=ANY($2::text[]) AND status='active'
    ORDER BY id COLLATE "C" LIMIT 257 FOR UPDATE`,[context.plan.workspaceId,paths]) as Array<{row_json:Row|null}>;
  if (selected.length>256 || selected.some(row=>!row.row_json)) fail();
  if (await database.get(`SELECT 1 AS found FROM ${table(schema,'file_collaboration_lineages')} WHERE workspace_id=$1 AND status='active'
    AND EXISTS(SELECT 1 FROM unnest($2::text[]) scope WHERE left(path,length(scope)+1)=scope||'/')
    AND NOT path=ANY($3::text[]) LIMIT 1`,[context.plan.workspaceId,paths,known])) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  const result=selected.map(row=>row.row_json!); lineageRows(result,context,planPaths(context).sources); return result;
}
function validateBefore(stage: AnyWorkspaceOperationOriginalMoveNamespaceStage, context: WorkspaceOperationOriginalMoveContext, now:number) {
  const {sources,destinations}=planPaths(context), sourceSet=new Set(sources), destinationSet=new Set(destinations);
  for(const key of ['metadata','userStates','publicShares'] as const)
    if(stage.beforeRows[key].some(row=>!sourceSet.has(String(row.path)) || destinationSet.has(String(row.path)))) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  for(const row of stage.beforeRows.locks) {
    if(Number(row.expiresAt)>now && (!sourceSet.has(String(row.path)) || row.lockedByUserId!==context.actor.userId
      || row.lockedBySessionId!==context.actor.actorSessionId)) fail('ORIGINAL_MOVE_NAMESPACE_BUSY');
    if(row.lineageId!==null && sourceSet.has(String(row.path))
      && !stage.lineages.some(lineage=>lineage.path===row.path && lineage.id===row.lineageId)) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  }
}
async function realm(database:SqlConnection,schema:string) {
  const row=await database.get('SELECT current_schema() AS schema_name, floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS clock_ms') as Row|undefined;
  if(row?.schema_name!==schema) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
  const now=Number(row.clock_ms); clock(now); return now;
}
/** Fixed bounded before-image only; the caller owns current policy, transaction,
 * immutable-journal staging and all filesystem/admission fences. */
export async function captureWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database:SqlConnection,input:{
  schema:string;workspace:WorkspaceContext;context:WorkspaceOperationOriginalMoveContext;
  observation?: WorkspaceLinkSourceAuthorityObservation; currentWitness?: unknown;
}):Promise<WorkspaceOperationOriginalMoveNamespaceState|null> {
  const {context,schema,workspace}=input,{effects,sources,destinations,known}=planPaths(context);
  if(!effects.length)return null;
  if(workspace.workspaceId!==context.plan.workspaceId || workspace.organizationId!==context.plan.sourceEvidence.workspaceScope.organizationId) fail();
  const now=await realm(database,schema);
  const beforeRows=await readWorkspacePathSideEffectRowsOnConnection(database,schema,workspace.workspaceId,[...sources,...destinations],undefined,undefined,known);
  let pristine: Awaited<ReturnType<typeof capturePristineRegistry>> | undefined;
  const active = await database.get(`SELECT 1 AS found FROM ${table(schema,'collaboration_documents')} WHERE workspace_id=$1
    AND path=ANY($2::text[]) AND status='active' LIMIT 1`,[context.plan.workspaceId,[...sources,...destinations]]);
  if (active) pristine = await capturePristineRegistry(database, input);
  const lineages=await readLineages(database,schema,context,pristine?.records);
  const stageText=canonical({version:pristine ? 2 : 1,batchId:context.batchId,planId:context.plan.planId,workspaceId:workspace.workspaceId,
    organizationId:workspace.organizationId,requestHash:context.requestHash,actor:context.actor,schema,
    effectsProof:nativeLinkJsonProof(effects),beforeRows,lineages,
    ...(pristine ? { catalogueBinding: pristine.binding, pristineRegistry: pristine.records } : {}) });
  const stage=decodeWorkspaceOperationOriginalMoveNamespaceStage(stageText,context,input.currentWitness); validateBefore(stage,context,now);
  return Object.freeze({stageText,stageDigest:sha(stageText)});
}
/** Fixed Move-owner consumer. A plain DTO or another connection cannot enter;
 * actual DA04 mutation authority and the immutable original journal are required. */
export async function applyWorkspaceOperationOriginalMoveNamespaceEffectsOnConnection(database:SqlConnection,input:{
  workspace:WorkspaceContext;context:WorkspaceOperationOriginalMoveContext;intent:WorkspaceOperationOriginalMoveIntentData;
}):Promise<{effectsProof:string;receiptDigest:string;receiptText:string}|null> {
  const {readWorkspaceOperationOriginalMoveSourcesContext}=await import('./workspace-operation-job-lifecycle-owner');
  const actual=await readWorkspaceOperationOriginalMoveSourcesContext(database);
  if(!equal(input.context,actual.context)||!equal(input.intent,actual.intent)||input.workspace.workspaceId!==actual.context.plan.workspaceId) fail();
  if(!actual.intent.namespaceEffects.length)return null;
  const state=actual.intent.namespaceState; if(!state)fail();
  const witness = actual.intent.version === 1 ? undefined : actual.intent.currentWitness;
  const stage=decodeWorkspaceOperationOriginalMoveNamespaceStage(state.stageText,actual.context,witness);
  if(sha(state.stageText)!==state.stageDigest)fail();
  return withCollaborationAdmissionMutation(database,actual.context.plan.actions[0].kind,async assertActive=>{
    const check=async()=>{assertActive();await actual.assertCurrent();assertActive();};
    await check(); const now=await realm(database,stage.schema); validateBefore(stage,actual.context,now);
    const {sources,destinations,known}=planPaths(actual.context),paths=[...sources,...destinations];
    const before=await readWorkspacePathSideEffectRowsOnConnection(database,stage.schema,input.workspace.workspaceId,paths,undefined,undefined,known);
    const lineages=await readLineages(database,stage.schema,actual.context,stage.version === 2 ? stage.pristineRegistry : undefined); await check();
    if(!equal(before,stage.beforeRows)||!equal(lineages,stage.lineages))fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
    const expected=after(stage,actual.context,now), mappings=planPaths(actual.context).effects;
    const write=async(sql:string,values:unknown[],count:number)=>{await check();const result=await database.run(sql,values) as {changes?:number};
      assertActive();if(result.changes!==count)fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');await check();};
    for(const mapping of mappings)for(const key of ['metadata','userStates'] as const){
      const spec=NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.find(spec=>spec.key===key)!;
      await write(`UPDATE ${table(stage.schema,spec.table)} SET path=$1 WHERE workspace_id=$2 AND path=$3`,
        [mapping.destinationPath,input.workspace.workspaceId,mapping.sourcePath],stage.beforeRows[key].filter(row=>row.path===mapping.sourcePath).length);
    }
    for(const row of expected.rows.publicShares)await write(`UPDATE ${table(stage.schema,'public_file_shares')}
      SET status='revoked',policy_revision=policy_revision+1,revoked_at=$1,revoked_reason='target_moved',updated_at=$1
      WHERE workspace_id=$2 AND id=$3 AND status='active'`,[now,input.workspace.workspaceId,row.id],1);
    for(const row of [...expected.rows.locks].sort((a,b)=>Number(a.status==='active')-Number(b.status==='active')))
      await write(`UPDATE ${table(stage.schema,'file_locks')} SET path=$1,status=$2,updated_at=$3 WHERE workspace_id=$4 AND id=$5 AND status='active'`,
        [row.path,row.status,now,input.workspace.workspaceId,row.id],1);
    if (stage.version === 2) for (const record of stage.pristineRegistry) {
      const destination = mappings.find(mapping => mapping.sourcePath === record.registry.path)?.destinationPath;
      if (!destination) fail();
      await write(`UPDATE ${table(stage.schema,'collaboration_documents')} d SET path=$1
        WHERE d.id=$2 AND d.workspace_id=$3 AND to_jsonb(d)=$4::jsonb
          AND d.provider='yjs' AND d.status='active' AND d.yjs_state_lifecycle='never_initialized' AND d.state_version=0
          AND ${pristineAbsenceSql(stage.schema, 'd')}`,
      [destination,record.registry.id,input.workspace.workspaceId,canonical(record.registry)],1);
    }
    for(const row of expected.lineages)await write(`UPDATE ${table(stage.schema,'file_collaboration_lineages')}
      SET path=$1 WHERE workspace_id=$2 AND id=$3 AND status='active'
        ${stage.version === 2 ? 'AND to_jsonb(file_collaboration_lineages)=$4::jsonb' : ''}`,[row.path,input.workspace.workspaceId,row.id,
          ...(stage.version === 2 ? [canonical(stage.lineages.find(item => item.id === row.id))] : [])],1);
    const observed=await readWorkspacePathSideEffectRowsOnConnection(database,stage.schema,input.workspace.workspaceId,paths,expected.rows,undefined,known);
    // Read only exact originally selected lineage IDs after their path transition.
    const actualLineages=await database.all(`SELECT to_jsonb(l) AS row_json FROM ${table(stage.schema,'file_collaboration_lineages')} l
      WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,
    [input.workspace.workspaceId,stage.lineages.map(row=>row.id)]) as Array<{row_json:Row}>;
    await check();if(!equal(observed,expected.rows)||!equal(actualLineages.map(row=>row.row_json),expected.lineages))fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
    if (stage.version === 2) {
      const registryAfter = await readPristineRegistryRows(database, stage.schema, actual.context, stage.pristineRegistry.map(item => item.registry.id));
      if (!equal(registryAfter, expected.pristineRegistry?.map(item => item.registry))) fail('ORIGINAL_MOVE_NAMESPACE_CHANGED');
    }
    const receiptText=canonical({version:stage.version,batchId:actual.context.batchId,planId:actual.context.plan.planId,workspaceId:input.workspace.workspaceId,
      effectsProof:stage.effectsProof,stageDigest:state.stageDigest,appliedAt:now,afterRowsProof:nativeLinkJsonProof(expected),
      rowCounts:Object.fromEntries([...keys.map(key=>[key,stage.beforeRows[key].length]),['lineages',stage.lineages.length],
        ...(stage.version === 2 ? [['pristineRegistry',stage.pristineRegistry.length]] : [])])});
    decodeWorkspaceOperationOriginalMoveNamespaceReceipt(receiptText,actual.context,state,witness);await check();
    return Object.freeze({effectsProof:stage.effectsProof,receiptDigest:sha(receiptText),receiptText});
  });
}
