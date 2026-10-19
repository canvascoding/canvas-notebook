import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { SqlConnection } from '../db';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest, type CollaborationAdmissionStatus } from '../collaboration/room-admission-contract';
import { captureCollaborationAdmissionOutcomeResult, readHistoricalCollaborationAdmissionOutcomeOnConnection,
  type CollaborationAdmissionOutcome } from '../collaboration/room-admission-outcome';
import type { WorkspaceNativeSourceBinding } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { decodeWorkspaceOperationNativeDeleteBatchPlan, WorkspaceOperationNativeDeletePlanError } from './workspace-operation-native-delete-plan';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';
import { captureOriginalDeleteAdmissionBinding, WorkspaceOperationOriginalDeleteError,
  type OriginalIntent, type WorkspaceOperationOriginalDeleteResult } from './workspace-operation-original-delete-evidence';

type DeleteAdmissionOriginal = Pick<OriginalIntent, 'batchId' | 'planId' | 'requestHash' | 'actor' | 'jobScope'>;
type Row = Record<string, unknown>;
export type WorkspaceOperationOriginalDeleteAdmissionRead = Readonly<{
  request: CollaborationAdmissionRequest; status: CollaborationAdmissionStatus; outcome: CollaborationAdmissionOutcome | null;
}>;

/** The existing archive protocol's exact seed, actor payload, field order and
 * document projection. This is data only, never a reservation or archive grant. */
function deleteAdmissionRequest(originalFields: DeleteAdmissionOriginal,
  nativeBindings: readonly WorkspaceNativeSourceBinding[]): CollaborationAdmissionRequest {
  const { batchId, planId, requestHash, actor, jobScope } = originalFields;
  const hex = createHash('sha256').update(`canvas.original-delete.admission.v1\0${batchId}\0${requestHash}\0${planId}`).digest('hex');
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const actionPayloadText = JSON.stringify({ version: 1, batchId, planId, requestHash,
    originalActor: { userId: actor.userId, actorId: actor.actorId, actorType: actor.actorType, actorSessionId: actor.actorSessionId ?? null },
    jobScope });
  return captureCollaborationAdmissionRequest({ requestId, actorId: actor.actorId, action: 'archive', actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('archive', actionPayloadText),
    scopes: [{ workspaceId: jobScope.workspaceId, organizationId: jobScope.organizationId, path: '', kind: 'subtree' }],
    expectedDocuments: nativeBindings.map(item => ({ documentId: item.expected.documentId,
      workspaceId: item.expected.workspaceId, organizationId: item.expected.organizationId, path: item.expected.path,
      representation: item.expected.representation, lifecycleGeneration: item.expected.lifecycleGeneration,
      schemaVersion: item.expected.schemaVersion, status: 'active' })) }).request;
}

/** Pure original request data, never current authority or an archive grant. */
export function createWorkspaceOperationOriginalDeleteAdmissionRequest(binding: WorkspaceOperationBatchClaimBinding): CollaborationAdmissionRequest {
  const auth = binding.authorization;
  if (binding.actionMode !== 'apply' || auth.mode !== 'direct' && auth.mode !== 'direct-mcp' || !auth.jobScope
    || binding.plan.version !== 2) throw new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_INVALID');
  const plan = decodeWorkspaceOperationNativeDeleteBatchPlan(binding.plan);
  if (binding.planId !== plan.planId || binding.workspaceId !== plan.workspaceId || !equal(plan.sourceEvidence.workspaceScope, auth.jobScope)) {
    throw new WorkspaceOperationNativeDeletePlanError('NATIVE_DELETE_PLAN_CHANGED');
  }
  return deleteAdmissionRequest({ batchId: binding.batchId, planId: plan.planId, requestHash: auth.requestHash,
    actor: { userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null },
    jobScope: auth.jobScope }, plan.sourceEvidence.nativeBindings);
}

/** Only the fixed original Delete completion map belongs in a V1 outcome. */
export function workspaceOperationOriginalDeleteAdmissionResult(result: WorkspaceOperationOriginalDeleteResult): Readonly<Record<string, string>> {
  if (!result || typeof result !== 'object' || types.isProxy(result) || Object.getPrototypeOf(result) !== Object.prototype) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const keys = ['intentDigest', 'receiptDigest', 'trashReceiptDigest', 'trashEntryId'] as const;
  const fields = {} as { [Key in typeof keys[number]]: PropertyDescriptor };
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
    const value = descriptor.value;
    if (typeof value !== 'string' || (key === 'trashEntryId'
      ? value.length !== 42 || !/^trash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
      : value.length !== 64 || !/^[0-9a-f]{64}$/u.test(value))) throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
    fields[key] = descriptor;
  }
  return captureCollaborationAdmissionOutcomeResult({ originalDeleteIntentDigest: fields.intentDigest.value as string,
    originalDeleteReceiptDigest: fields.receiptDigest.value as string,
    originalDeleteTrashReceiptDigest: fields.trashReceiptDigest.value as string, trashEntryId: fields.trashEntryId.value as string });
}

/** Bind every unqualified Admission read to the same actual permanent tables.
 * No transaction, lock, checkout, session, principal or Claim is created here. */
async function readOriginalDeleteAdmissionNamespace(database: SqlConnection, schema: string) {
  const realm = await database.get(`SELECT pg_catalog.current_schema() AS schema_name,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    CASE WHEN octet_length(pg_catalog.current_setting('search_path'))<=4096
      THEN pg_catalog.current_setting('search_path') END AS search_path`) as Row | undefined;
  if (!realm || realm.schema_name !== schema || typeof realm.search_path !== 'string' || !realm.search_path
    || /\u0000/u.test(realm.search_path) || !Number.isSafeInteger(Number(realm.schema_oid)) || Number(realm.schema_oid) < 1
    || Number(realm.schema_oid) > 4_294_967_295 || !Number.isSafeInteger(Number(realm.database_oid))
    || Number(realm.database_oid) < 1 || Number(realm.database_oid) > 4_294_967_295) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const names = ['collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
  const relations = await database.all(`SELECT n.name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved
    FROM pg_catalog.unnest($2::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(n.name)) ORDER BY n.name COLLATE "C"`,
  [`"${schema.replaceAll('"', '""')}"`, names]) as Row[];
  if (relations.length !== names.length || new Set(relations.map(row => row.name)).size !== names.length
    || relations.some(row => !names.includes(String(row.name)) || Number(row.schema_oid) !== Number(realm.schema_oid)
      || !Number.isSafeInteger(Number(row.oid)) || Number(row.oid) < 1 || Number(row.oid) > 4_294_967_295
      || Number(row.resolved) !== Number(row.oid) || row.relkind !== 'r' || row.relpersistence !== 'p'
      || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  return { realm, relations };
}

/** Borrowed factual reads only. Caller supplies a decoded V4 intent and owns
 * its consistent authorized B. A stored header never proves domain completion;
 * the exact actual V1 outcome and Delete receipt map must agree as well. */
export async function readWorkspaceOperationOriginalDeleteAdmissionOnConnection(database: SqlConnection,
  input: Readonly<{ schema: string; intent: OriginalIntent; result?: WorkspaceOperationOriginalDeleteResult }>):
Promise<WorkspaceOperationOriginalDeleteAdmissionRead> {
  const captured = captureWorkspaceOperationNativePlanData(input, () => {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }) as typeof input;
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)
    || Reflect.ownKeys(captured).length !== (Object.hasOwn(captured, 'result') ? 3 : 2)
    || !Object.hasOwn(captured, 'schema') || !Object.hasOwn(captured, 'intent')
    || typeof captured.schema !== 'string' || !captured.schema || Buffer.byteLength(captured.schema) > 63
    || /[\u0000-\u001f\u007f]/u.test(captured.schema) || Buffer.from(captured.schema).toString('utf8') !== captured.schema) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const { schema, intent, result } = captured;
  if (!intent || intent.version !== 4 || Reflect.ownKeys(intent).length !== 12
    || !['version', 'batchId', 'planId', 'requestHash', 'actor', 'jobScope', 'physical', 'native', 'publicShare',
      'nativeLinks', 'currentWitness', 'admission'].every(key => Object.hasOwn(intent, key))) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const actor = intent.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Reflect.ownKeys(actor).length !== 4
    || !['userId', 'actorId', 'actorType', 'actorSessionId'].every(key => Object.hasOwn(actor, key))
    || !['user', 'agent'].includes(actor.actorType)) throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  for (const value of [intent.batchId, actor.userId, actor.actorId, ...(actor.actorSessionId === null ? [] : [actor.actorSessionId])]) {
    if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim()
      || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) {
      throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
    }
  }
  if (intent.batchId.length < 16 || intent.batchId.length > 128 || ![intent.planId, intent.requestHash].every(value =>
    typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/u.test(value))) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const scope = parseWorkspaceOperationJobScope(intent.jobScope), witness = decodeWorkspaceOperationNativeSourceEvidence(intent.currentWitness);
  if (witness.evidenceVersion !== 2 || !equal(scope, witness.workspaceScope) || !intent.native
    || !equal(witness.nativeBindings.find(item => item.expected.documentId === intent.native!.documentId)?.expected, intent.native)) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const admission = captureOriginalDeleteAdmissionBinding(intent.admission);
  const request = captureCollaborationAdmissionRequest(deleteAdmissionRequest(intent, witness.nativeBindings));
  if (admission.requestId !== request.request.requestId || admission.requestDigest !== request.requestDigest) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const expectedResult = result === undefined ? null : workspaceOperationOriginalDeleteAdmissionResult(result);
  if (result && (result.version !== 4 || result.batchId !== intent.batchId || !intent.physical
    || result.trashEntryId !== intent.physical.trashEntryId)) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  const namespace = await readOriginalDeleteAdmissionNamespace(database, schema);
  const prefix = `"${schema.replaceAll('"', '""')}"`;
  const headerSql = `SELECT CASE WHEN octet_length(request_id)=36 THEN request_id END AS request_id,
    CASE WHEN octet_length(request_digest)=64 THEN request_digest END AS request_digest,
    CASE WHEN octet_length(intent_text)=$2 AND octet_length(intent_text)<=16777216 THEN intent_text END AS intent_text,
    CASE WHEN octet_length(status)<=32 THEN status END AS status,
    outcome_text IS NOT NULL AS has_outcome FROM ${prefix}.collaboration_admission_requests WHERE request_id=$1`;
  const parameters = [request.request.requestId, Buffer.byteLength(request.intentText)];
  const header = await database.get(headerSql, parameters) as Row | undefined;
  if (!header || header.request_id !== request.request.requestId || header.request_digest !== request.requestDigest
    || header.intent_text !== request.intentText || typeof header.has_outcome !== 'boolean'
    || !['reserved', 'draining', 'recovery_required', 'committed', 'cancelled'].includes(header.status as string)
    || header.has_outcome !== (header.status === 'committed')) throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  const outcome = await readHistoricalCollaborationAdmissionOutcomeOnConnection(database, request, { readOnly: true });
  if ((header.status === 'committed') !== (outcome !== null)
    || expectedResult !== null && (!outcome || outcome.version !== 1 || !equal(outcome.result, expectedResult))
    || expectedResult === null && outcome?.version === 1) throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  if (!equal(await database.get(headerSql, parameters), header)
    || !equal(await readOriginalDeleteAdmissionNamespace(database, schema), namespace)) {
    throw new WorkspaceOperationOriginalDeleteError('ORIGINAL_DELETE_UNPROVEN');
  }
  return Object.freeze({ request: request.request, status: header.status as CollaborationAdmissionStatus, outcome });
}
