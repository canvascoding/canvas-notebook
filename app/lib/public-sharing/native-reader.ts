import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import { withWorkspaceMutationLock } from '../files/workspace-mutation-lock';
import { withWorkspaceSideEffectWriterFenceOnConnection, type WorkspaceSideEffectWriterTarget } from '../files/workspace-side-effect-writer-fence';
import { workspaceAbsoluteRoot } from '../workspaces/contracts';
import type { WorkspaceContext } from '../workspaces/types';
import type { PublicShareRow } from './public-file-shares';
import { isSensitiveWorkspacePath } from './public-file-shares';
import { readPublicShareNativeTargetOnConnection } from './native-target';
import { readPublicShareOnConnection } from './repository';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const relations = ['public_file_shares', 'canvas_workspaces', 'collaboration_documents', 'file_collaboration_lineages',
  'collaboration_yjs_states', 'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];

export class PublicShareNativeReadError extends Error {
  constructor(readonly status: 404 | 409 | 410 | 503, message = 'Public document is unavailable.') {
    super(message); this.name = 'PublicShareNativeReadError';
  }
}
function unavailable(): never { throw new PublicShareNativeReadError(404); }

/** Bind the actual namespace before native SQL; a TEMP table is never a source
 * of public authority. DDL locks and row locks last through the outer COMMIT. */
async function bindReadRelations(database: SqlConnection) {
  const schema = await database.get('SELECT current_schema() AS name') as {name?: unknown} | undefined;
  if (typeof schema?.name !== 'string' || !schema.name || Buffer.byteLength(schema.name) > 63
    || /[\u0000-\u001f\u007f]/u.test(schema.name)) unavailable();
  const prefix = quote(schema.name);
  const read = () => database.all(`SELECT name,to_regclass(name)::oid::bigint AS resolved,
    to_regclass($1||'.'||quote_ident(name))::oid::bigint AS bound FROM unnest($2::text[]) names(name)`, [prefix, relations]) as
    Promise<Array<{name: string; resolved: string | number | null; bound: string | number | null}>>;
  const valid = (rows: Awaited<ReturnType<typeof read>>) => rows.length === relations.length
    && new Set(rows.map(row => row.name)).size === relations.length
    && rows.every(row => relations.includes(row.name) && Number.isSafeInteger(Number(row.bound)) && Number(row.bound) > 0
      && Number(row.resolved) === Number(row.bound));
  const initial = await read(); if (!valid(initial)) unavailable();
  const expected = new Map(initial.map(row => [row.name, Number(row.bound)]));
  await database.run(`LOCK TABLE ${relations.map(name => `${prefix}.${quote(name)}`).join(',')} IN ROW EXCLUSIVE MODE NOWAIT`);
  const assertCurrent = async () => {
    const current = await read();
    if (!valid(current) || current.some(row => expected.get(row.name) !== Number(row.bound))) unavailable();
  };
  await assertCurrent();
  return { prefix, table: `${prefix}.public_file_shares`, assertCurrent };
}

const authorityFields = ['id', 'token', 'tokenHash', 'shortCode', 'workspaceId', 'workspaceType', 'organizationId',
  'customerId', 'projectId', 'workspaceRootRelativePath', 'workspacePath', 'documentId', 'lineageId', 'lifecycleGeneration',
  'fileIdentity', 'targetRevisionPolicy', 'status', 'policyRevision', 'expiresAt', 'securityMode', 'passwordEnabled', 'passwordHash'] as const;
function assertPublicRow(row: PublicShareRow, expected: PublicShareRow, exact = false): void {
  if (row.status !== 'active' || row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    throw new PublicShareNativeReadError(410, 'Public document is no longer available.');
  }
  if (exact ? !isDeepStrictEqual(row, expected) : authorityFields.some(key => !isDeepStrictEqual(row[key], expected[key]))) {
    throw new PublicShareNativeReadError(409, 'Public document changed.');
  }
  if (row.passwordEnabled !== 0 || row.passwordHash !== null || row.securityMode !== 'strict'
    || row.targetRevisionPolicy !== 'latest' || !row.workspaceId || !row.documentId || !row.lineageId
    || !Number.isSafeInteger(row.lifecycleGeneration) || row.lifecycleGeneration! < 1
    || !isCanonicalAdmissionPath(row.workspacePath) || isSensitiveWorkspacePath(row.workspacePath)
    || createHash('sha256').update(row.token).digest('hex') !== row.tokenHash) unavailable();
}

/** A public token grants only this document read. It does not impersonate its
 * creator or mint a normal workspace/member principal. */
async function readPublicWorkspace(database: SqlConnection, prefix: string, row: PublicShareRow): Promise<WorkspaceContext> {
  const record = await database.get(`SELECT id,type,organization_id,customer_id,project_id,owner_user_id,
    root_relative_path,display_name,status FROM ${prefix}.canvas_workspaces WHERE id=$1 FOR SHARE NOWAIT`, [row.workspaceId]) as
    {id: string; type: string; organization_id: string; customer_id: string | null; project_id: string | null;
      owner_user_id: string | null; root_relative_path: string; display_name: string; status: string} | undefined;
  if (!record || record.status !== 'active' || record.id !== row.workspaceId || record.type !== row.workspaceType
    || !['personal', 'organization', 'team', 'project'].includes(record.type)
    || record.organization_id !== row.organizationId || record.root_relative_path !== row.workspaceRootRelativePath
    || row.customerId !== null && record.customer_id !== row.customerId || row.projectId !== null && record.project_id !== row.projectId
    || !isCanonicalAdmissionPath(record.root_relative_path)) unavailable();
  return { workspaceId: record.id, workspaceType: record.type as WorkspaceContext['workspaceType'],
    organizationId: record.organization_id, customerId: record.customer_id, projectId: record.project_id,
    ownerUserId: record.owner_user_id, rootRelativePath: record.root_relative_path,
    rootPath: workspaceAbsoluteRoot(record.root_relative_path), displayName: record.display_name, status: 'active', legacy: false,
    permissions: {canRead: true, canWrite: false, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false} };
}

/** The initial row is a selection only. Re-read and lock the genuine token,
 * exact original pins and current public policy on this B before any content.
 * The caller supplies a DB-selected row, never a user/actor authority object. */
export async function readNativePublicShare(initial: PublicShareRow, recordAccess = false) {
  // Copy Dates as well as primitive fields before the first await.
  const expected = structuredClone(initial);
  assertPublicRow(expected, expected);
  let prepared = false;
  let phase = 'kernel';
  try {
    return await withWorkspaceMutationLock(expected.workspaceId!, () => executeLifecycleTransaction({
      openConnection: openDb,
      execute: async database => {
        phase = 'relations';
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        const bound = await bindReadRelations(database);
        phase = 'share-row';
        const selected = await readPublicShareOnConnection(database, {table: bound.table, workspaceId: expected.workspaceId!, id: expected.id,
          ...(recordAccess ? {forUpdate: true as const} : {forShare: true as const})});
        if (!selected) unavailable();
        let row: PublicShareRow = selected;
        assertPublicRow(row, expected);
        phase = 'workspace-row';
        const workspace = await readPublicWorkspace(database, bound.prefix, row);
        phase = 'state-selector';
        const state = await database.get(`SELECT representation,schema_version FROM ${bound.prefix}.collaboration_yjs_states
          WHERE document_id=$1 AND workspace_id=$2 AND lifecycle_generation=$3 AND status='active'`,
        [row.documentId, row.workspaceId, row.lifecycleGeneration]) as {representation: WorkspaceSideEffectWriterTarget['representation']; schema_version: number} | undefined;
        if (!state || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(state.representation)
          || Number(state.schema_version) !== COLLABORATION_SCHEMA_VERSION) throw new PublicShareNativeReadError(409);
        const target: WorkspaceSideEffectWriterTarget = {kind: 'native_file', documentId: row.documentId!, lineageId: row.lineageId!,
          workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, path: row.workspacePath,
          lifecycleGeneration: row.lifecycleGeneration!, representation: state.representation, schemaVersion: Number(state.schema_version)};
        phase = 'fence';
        const result = await withWorkspaceSideEffectWriterFenceOnConnection(database, {workspace, targets: [target]}, async () => {
          phase = 'snapshot';
          const native = await readPublicShareNativeTargetOnConnection(database, {workspace, target, prefix: bound.prefix});
          if (recordAccess) {
            phase = 'counter';
            if (row!.accessCount >= Number.MAX_SAFE_INTEGER) unavailable();
            const now = Date.now();
            const updated = await database.get(`UPDATE ${bound.table} SET access_count=access_count+1,last_accessed_at=$1
              WHERE id=$2 AND workspace_id=$3 AND token_hash=$4 AND policy_revision=$5 AND status='active'
                AND (expires_at IS NULL OR expires_at>$1) AND document_id=$6 AND lineage_id=$7 AND lifecycle_generation=$8
                AND security_mode='strict' AND password_enabled=0 RETURNING id`,
            [now,row!.id,row!.workspaceId,row!.tokenHash,row!.policyRevision,row!.documentId,row!.lineageId,row!.lifecycleGeneration]) as {id: string} | undefined;
            if (updated?.id !== row!.id) unavailable();
            const stored = await readPublicShareOnConnection(database, {table: bound.table, workspaceId: expected.workspaceId!, id: expected.id});
            const counted = {...row!, accessCount: row!.accessCount + 1, lastAccessedAt: new Date(now)};
            if (!stored) unavailable(); assertPublicRow(stored, counted, true); row = stored;
          }
          phase = 'final-row';
          await bound.assertCurrent();
          const current = await readPublicShareOnConnection(database, {table: bound.table, workspaceId: expected.workspaceId!, id: expected.id});
          if (!current) unavailable(); assertPublicRow(current, row!, true);
          // This return is still inside the shared SQL fence and outer kernel;
          // neither bytes nor an access success escape before COMMIT/cleanup.
          phase = 'fence-completion';
          return {row: current, workspace, ...native};
        });
        assertPublicRow(result.row, result.row, true);
        prepared = true;
        return result;
      },
      recoverCommitted: async () => { throw new PublicShareNativeReadError(503, 'Public read completion could not be confirmed.'); },
    }));
  } catch (error) {
    if (error && typeof error === 'object' && ['55P03', '40P01'].includes(String(Reflect.get(error, 'code')))) {
      console.warn('[public-sharing] Native read lock rejected.', {phase, code: String(Reflect.get(error, 'code'))});
    }
    if (prepared) throw new PublicShareNativeReadError(503, 'Public read completion could not be confirmed.');
    throw error;
  }
}
