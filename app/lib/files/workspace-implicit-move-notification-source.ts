import 'server-only';

import { isDeepStrictEqual as equal } from 'node:util';
import type { FileVersionCenterTransaction } from '../file-version-center/database';
import type { WorkspaceContext } from '../workspaces/types';
import { captureCollaborationAdmissionRequest } from '../collaboration/room-admission-contract';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { decodeWorkspaceImplicitMoveSelectionRequest } from './workspace-implicit-move-selection';
import { WORKSPACE_PATH_PREPARATION_NOTIFICATION_PREFIX, workspacePathOperationHref,
  type WorkspacePathOperationNotificationTarget } from './workspace-operation-notification-contract';
import type { WorkspacePathOperationNotificationItem } from './workspace-operation-notification-source';

type Scope = Readonly<{ userId: string; workspace: WorkspaceContext }>;
type Row = Record<string, unknown>;
export type WorkspaceImplicitMovePreparationNotificationFact = Readonly<{
  requestId: string; requestDigest: string; revision: number; createdAt: number;
  item: WorkspacePathOperationNotificationItem;
}>;
const unavailable = (): never => { throw new Error('Implicit file preparation notifications could not be verified.'); };
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Bounded SELECT-only discovery of this user's actual saved preparations.
 * These are navigation facts; only the existing genuine GET/POST Coordinator
 * may authorize/read/advance their complete original history. */
export async function listWorkspaceImplicitMovePreparationNotificationFacts(transaction: FileVersionCenterTransaction,
  input: Scope): Promise<readonly WorkspaceImplicitMovePreparationNotificationFact[]> {
  const { workspace, userId } = input;
  if (!userId || workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
    || !workspace.permissions.canWrite || !workspace.permissions.canDelete) return [];
  const currentScope = captureWorkspaceOperationJobScope(workspace);
  const realm = (await transaction.query<Row>(`SELECT pg_catalog.current_schema() AS schema,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.current_setting('search_path') AS search_path,
    (SELECT jsonb_agg(jsonb_build_object('name',names.name,'valid',c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnamespace=pg_catalog.to_regnamespace(pg_catalog.current_schema())
      AND c.oid=pg_catalog.to_regclass(pg_catalog.quote_ident(names.name))) ORDER BY names.name COLLATE "C")
      FROM pg_catalog.unnest(ARRAY['canvas_workspaces','collaboration_admission_requests',
        'collaboration_admission_scopes','mobile_inbox_read_states']::text[]) names(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(
        pg_catalog.quote_ident(pg_catalog.current_schema())||'.'||pg_catalog.quote_ident(names.name))) AS relations,
    w.id,w.type,w.organization_id,w.customer_id,w.project_id,w.owner_user_id,w.root_relative_path,w.status
    FROM canvas_workspaces w WHERE w.id=$1`, [workspace.workspaceId])).rows[0];
  if (!realm || typeof realm.schema !== 'string' || typeof realm.search_path !== 'string'
    || !Number.isSafeInteger(Number(realm.schema_oid)) || Number(realm.schema_oid) < 1
    || !Number.isSafeInteger(Number(realm.database_oid)) || Number(realm.database_oid) < 1
    || !Array.isArray(realm.relations) || realm.relations.length !== 4
    || realm.relations.some(row => !row || row.valid !== true)
    || realm.id !== currentScope.workspaceId || realm.type !== currentScope.workspaceType
    || (realm.organization_id ?? null) !== currentScope.organizationId || (realm.customer_id ?? null) !== currentScope.customerId
    || (realm.project_id ?? null) !== currentScope.projectId || (realm.owner_user_id ?? null) !== currentScope.ownerUserId
    || (realm.root_relative_path ?? null) !== currentScope.rootRelativePath || realm.status !== 'active') unavailable();
  // Filter only actual implicit-selection headers. SQL JSON predicates are
  // guarded, and the returned body budget is bounded across the complete page.
  // A recognized malformed/oversized selection makes this source unavailable,
  // rather than converting a partial list into proof that nothing is pending.
  const rows = (await transaction.query<Row>(`WITH selected AS MATERIALIZED (
    SELECT r.request_id,r.request_digest,r.status,r.revision,r.created_at,r.intent_text,
      COALESCE(state.read_at,0) AS read_at,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal',s.ordinal,'workspaceId',s.workspace_id,
        'organizationId',s.organization_id,'path',s.path,'kind',s.kind) ORDER BY s.ordinal),'[]'::jsonb)
        FROM collaboration_admission_scopes s WHERE s.request_id=r.request_id) AS scopes
    FROM collaboration_admission_requests r
    LEFT JOIN mobile_inbox_read_states state ON state.user_id=$2 AND state.workspace_id=$1
      AND state.item_key=$3||r.request_id
    WHERE r.status IN ('reserved','draining','recovery_required')
      AND EXISTS (SELECT 1 FROM collaboration_admission_scopes s WHERE s.request_id=r.request_id
        AND s.workspace_id=$1 AND s.organization_id IS NOT DISTINCT FROM $4 AND s.path='' AND s.kind='subtree')
      AND CASE WHEN r.intent_text IS JSON OBJECT THEN r.intent_text::jsonb->>'actorId'=$2
        AND CASE WHEN (r.intent_text::jsonb->>'actionPayloadText') IS JSON OBJECT
          THEN (r.intent_text::jsonb->>'actionPayloadText')::jsonb->>'kind'='implicit-native-move-selection'
          ELSE FALSE END ELSE FALSE END
    ORDER BY r.created_at DESC,r.request_id COLLATE "C" LIMIT 201
  ), bounded AS (
    SELECT selected.*,SUM(octet_length(intent_text)) OVER (ORDER BY created_at DESC,request_id COLLATE "C") AS body_bytes
    FROM selected
  ) SELECT request_id,request_digest,status,revision,created_at,read_at,scopes,
    CASE WHEN octet_length(intent_text) BETWEEN 1 AND 2097152 AND body_bytes<=8388608 THEN intent_text END AS intent_text
    FROM bounded ORDER BY created_at DESC,request_id COLLATE "C"`,
  [workspace.workspaceId, userId, WORKSPACE_PATH_PREPARATION_NOTIFICATION_PREFIX, currentScope.organizationId])).rows;
  if (rows.length > 200) unavailable();
  return rows.map((row): WorkspaceImplicitMovePreparationNotificationFact => {
    if (typeof row.intent_text !== 'string' || !['reserved','draining','recovery_required'].includes(String(row.status))) return unavailable();
    let raw: unknown; try { raw = JSON.parse(row.intent_text); } catch { return unavailable(); }
    const selection = decodeWorkspaceImplicitMoveSelectionRequest(raw as Parameters<typeof decodeWorkspaceImplicitMoveSelectionRequest>[0]);
    const captured = captureCollaborationAdmissionRequest(raw as Parameters<typeof captureCollaborationAdmissionRequest>[0]);
    const createdAt = Number(row.created_at), revision = Number(row.revision), readAt = Number(row.read_at);
    if (captured.intentText !== row.intent_text || captured.requestDigest !== row.request_digest
      || captured.request.requestId !== row.request_id || captured.request.actorId !== userId || selection.origin.userId !== userId
      || !equal(selection.scope,currentScope) || selection.origin.schema !== realm.schema
      || selection.origin.schemaOid !== Number(realm.schema_oid) || selection.origin.databaseOid !== Number(realm.database_oid)
      || selection.origin.searchPath !== realm.search_path || !integer(createdAt) || createdAt > 8.64e15
      || !integer(revision) || revision < 1 || !integer(readAt)
      || !equal(row.scopes,[{ ordinal: 0, workspaceId: workspace.workspaceId, organizationId: currentScope.organizationId,
        path: '', kind: 'subtree' }])) unavailable();
    const target: WorkspacePathOperationNotificationTarget = { kind: 'file_path_operation', workspaceId: workspace.workspaceId,
      operationKind: selection.action, status: 'pending', preparationRequestId: captured.request.requestId };
    const item: WorkspacePathOperationNotificationItem = {
      id: `${WORKSPACE_PATH_PREPARATION_NOTIFICATION_PREFIX}${captured.request.requestId}`,
      type: 'file.operation_attention', title: 'File action preparation is pending', detail: selection.selections[0].sourcePath,
      previewUrl: null, deepLink: workspacePathOperationHref(target), occurredAt: new Date(createdAt).toISOString(),
      unread: readAt < createdAt, notificationRevision: String(createdAt), priority: 'normal', target,
      workspaceId: workspace.workspaceId, workspaceName: workspace.displayName ?? null };
    return Object.freeze({ requestId: captured.request.requestId, requestDigest: captured.requestDigest, revision, createdAt, item });
  });
}

/** Inbox read state only. This never changes an admission, reservation or file.
 * Pending entries remain discoverable on Home even after being marked read. */
export async function markWorkspaceImplicitMovePreparationNotificationsRead(transaction: FileVersionCenterTransaction,
  input: Scope & { itemId?: string }, now: number): Promise<{ updated: number }> {
  if (!integer(now)) unavailable();
  const facts = await listWorkspaceImplicitMovePreparationNotificationFacts(transaction,input);
  let updated = 0;
  for (const fact of facts) {
    if (input.itemId !== undefined && input.itemId !== fact.item.id) continue;
    const result = await transaction.query<Row>(`INSERT INTO mobile_inbox_read_states
      (user_id,workspace_id,item_key,read_at,dismissed_at,created_at,updated_at)
      SELECT $2,$1,$3,$4,NULL,$5,$5 FROM collaboration_admission_requests r
      WHERE r.request_id=$6 AND r.request_digest=$7 AND r.revision=$8
        AND r.status IN ('reserved','draining','recovery_required')
      ON CONFLICT(user_id,workspace_id,item_key) DO UPDATE SET read_at=EXCLUDED.read_at,updated_at=EXCLUDED.updated_at
      RETURNING item_key`, [input.workspace.workspaceId,input.userId,fact.item.id,fact.createdAt,now,
      fact.requestId,fact.requestDigest,fact.revision]);
    updated += result.rows.length;
  }
  return { updated };
}
