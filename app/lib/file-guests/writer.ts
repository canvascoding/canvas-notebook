import 'server-only';

import type { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { withFileGuestInvitationAuthority, withFileGuestInvitationAuthorityOnConnection,
  withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection,
  type FileGuestInvitationAuthorityPurpose, type FileGuestInvitationAuthorityTarget } from '@/app/lib/workspaces/request-principal';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { getWorkspaceFileLifecycleLeases } from '@/app/lib/collaboration/file-lifecycle-admission-context';
import { assertCollaborationAdmissionOpen } from '@/app/lib/collaboration/room-admission';
import { CollaborationAdmissionError, collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { lockFileCollaborationPaths } from '@/app/lib/files/collaboration-repository/transaction';
import { withWorkspaceSideEffectWriterFenceOnConnection, withWorkspaceSideEffectWriterMutationOnConnection,
  WorkspaceSideEffectWriterFenceError } from '@/app/lib/files/workspace-side-effect-writer-fence';
import { readFileGuestNativeTargetOnConnection } from './target';
import { isFileGuestId } from './types';

/** No success, email or session token may be published for an unknown COMMIT. */
export class FileGuestWriterCommitError extends Error {
  readonly code = 'FILE_GUEST_WRITE_COMMIT_UNCONFIRMED';
  readonly status = 503;
  constructor() {
    super('Der Abschluss der Gastaktion ist unklar. Bitte den aktuellen Stand neu laden.');
    this.name = 'FileGuestWriterCommitError';
  }
}

export class FileGuestWriterError extends Error {
  constructor(readonly code: 'FILE_GUEST_WRITE_INVALID' | 'FILE_GUEST_WRITE_CHANGED' | 'FILE_GUEST_WRITE_DENIED') {
    super(code); this.name = 'FileGuestWriterError';
  }
  get status() { return this.code === 'FILE_GUEST_WRITE_INVALID' ? 400 : this.code === 'FILE_GUEST_WRITE_CHANGED' ? 409 : 403; }
}

type InvitationWriteAccess = Readonly<{
  database: SqlConnection; workspace: WorkspaceContext; invitation: FileGuestInvitationAuthorityTarget;
  assertCurrent: () => Promise<void>;
}>;

/**
 * Internal service boundary, not a caller-provided WorkspaceContext grant.
 * Preparation and email stay outside. Only narrow SQL runs in this callback;
 * it must not acquire a pool connection, filesystem kernel or content session.
 * Invalid OTP outcomes return normally so their attempt counters also COMMIT.
 */
export async function withFileGuestInvitationWriter<T>(id: string, purpose: FileGuestInvitationAuthorityPurpose,
  operation: (access: InvitationWriteAccess) => Promise<T>): Promise<T> {
  let prepared = false;
  try {
    return await withFileGuestInvitationAuthority(id,purpose, authority => executeLifecycleTransaction({
      openConnection: openDb,
      execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        const result = await withFileGuestInvitationAuthorityOnConnection(database,authority,async access => {
          const target = await readFileGuestNativeTargetOnConnection(database,access.workspace,access.invitation);
          return withWorkspaceSideEffectWriterFenceOnConnection(database,{workspace:access.workspace,targets:[target]},() =>
            withWorkspaceSideEffectWriterMutationOnConnection(database,target,async assertTarget => {
              await lockFileCollaborationPaths(database,access.workspace.workspaceId,[target.path]);
              // The Shared admission lock always precedes this row lock.
              await database.get('SELECT id FROM file_guest_invitations WHERE id=$1 FOR UPDATE',[id]);
              let active = true;
              const assertCurrent = async () => {
                if (!active) throw new FileGuestWriterError('FILE_GUEST_WRITE_DENIED');
                await access.assertCurrent(); await assertTarget();
                if (!active) throw new FileGuestWriterError('FILE_GUEST_WRITE_DENIED');
              };
              try {
                await assertCurrent();
                const result = await operation(Object.freeze({database,workspace:access.workspace,invitation:access.invitation,assertCurrent}));
                await assertCurrent(); return result;
              } finally { active = false; }
            }));
        });
        // Set only after all final Principal and Shared-fence checks return.
        prepared = true; return result;
      },
      recoverCommitted: async () => { throw new FileGuestWriterCommitError(); },
    }));
  } catch (error) {
    // Includes discard failure or a release failure after confirmed COMMIT.
    // The original transaction helper owns exactly one connection disposal.
    if (prepared) throw new FileGuestWriterCommitError();
    throw error;
  }
}

type RevocationRow = { id:string;workspace_id:string;path:string;document_id:string;policy_revision:number|string;
  created_by_user_id:string;status:string };

async function assertRevocationAdmission(database: SqlConnection, workspaceId: string, row: RevocationRow): Promise<void> {
  try {
    if (isCanonicalAdmissionPath(row.path)) {
      await assertCollaborationAdmissionOpen(async (sql,values) => database.all(sql,values) as Promise<Record<string,unknown>[]>,
        {workspaceId,path:row.path,documentId:row.document_id});
    } else {
      // Historical malformed names are never normalized onto another file.
      // Conservatively freeze revocation during any reserved workspace path.
      const reserved = await database.get(`SELECT 1 FROM collaboration_admission_scopes s
        JOIN collaboration_admission_requests r ON r.request_id=s.request_id
        WHERE s.workspace_id=$1 AND r.status NOT IN ('committed','cancelled')
        UNION ALL SELECT 1 FROM collaboration_admission_targets WHERE document_id=$2 AND active LIMIT 1`,[workspaceId,row.document_id]);
      if (reserved) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
    }
  } catch (error) {
    if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') throw new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_BUSY');
    throw error;
  }
}

/**
 * Monotone member-only revocation. A missing/currently different document or
 * legacy NULL pin cannot prevent removing a grant. This lane never rebinds,
 * renews, changes permission or creates sessions. The exact stored invitation
 * and current member rights remain protected on B through confirmed COMMIT.
 */
export async function revokeFileGuestInvitation(request: NextRequest,
  input: Readonly<{workspaceId:string;id:string;policyRevision:number}>): Promise<{id:string;policyRevision:number;status:'revoked'}> {
  if (!input || !isFileGuestId(input.id) || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) throw new FileGuestWriterError('FILE_GUEST_WRITE_INVALID');
  const expected = Object.freeze({...input});
  await requireTeamRuntimeLicense();
  let prepared = false;
  try {
    return await withWorkspaceRequestPrincipal(request,{workspaceId:expected.workspaceId,permission:'canRead'},principal => executeLifecycleTransaction({
      openConnection:openDb,
      execute:async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        const result = await withWorkspaceRequestPrincipalOnConnection(database,principal,async access => {
          const workspace = access.workspace;
          if (workspace.workspaceId !== expected.workspaceId || !workspace.permissions.canCreatePublicLinks) throw new FileGuestWriterError('FILE_GUEST_WRITE_DENIED');
          if (getWorkspaceFileLifecycleLeases()?.has(workspace.workspaceId)) throw new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_REENTRANT');
          const realm = await database.get('SELECT current_schema() AS name') as {name:string};
          const prefix = `"${realm.name.replaceAll('"','""')}"`;
          const relations = ['file_guest_invitations','collaboration_admission_requests','collaboration_admission_scopes','collaboration_admission_targets'];
          const assertRelations = async () => {
            await access.assertCurrent();
            const rows = await database.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same
              FROM unnest($2::text[]) names(name)`,[prefix,relations]) as Array<{name:string;same:boolean}>;
            if (rows.length !== relations.length || rows.some(row => row.same !== true)) throw new FileGuestWriterError('FILE_GUEST_WRITE_CHANGED');
          };
          // The member Principal protects auth tables. Bind these additional
          // relations separately; never mutate a temporary shadow invitation.
          await assertRelations();
          await database.run(`LOCK TABLE ${relations.map(name => `${prefix}."${name}"`).join(',')} IN ROW SHARE MODE NOWAIT`);
          const shared = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
            [collaborationAdmissionLockKey(workspace.workspaceId)]) as {locked?:boolean}|undefined;
          if (shared?.locked !== true) throw new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_BUSY');
          const read = async () => await database.get(`SELECT id,workspace_id,path,document_id,policy_revision,created_by_user_id,status
            FROM ${prefix}.file_guest_invitations WHERE id=$1`,[expected.id]) as RevocationRow|undefined;
          const before = await read();
          if (!before || before.workspace_id !== workspace.workspaceId || Number(before.policy_revision) !== expected.policyRevision || before.status !== 'active') throw new FileGuestWriterError('FILE_GUEST_WRITE_CHANGED');
          if (before.created_by_user_id !== access.userId && !workspace.permissions.canManageWorkspace) throw new FileGuestWriterError('FILE_GUEST_WRITE_DENIED');
          await assertRevocationAdmission(database,workspace.workspaceId,before);
          await lockFileCollaborationPaths(database,workspace.workspaceId,[before.path]);
          await database.get(`SELECT id FROM ${prefix}.file_guest_invitations WHERE id=$1 FOR UPDATE`,[expected.id]);
          const current = await read();
          if (!current || Object.keys(before).some(key => Reflect.get(before,key) !== Reflect.get(current,key))) throw new FileGuestWriterError('FILE_GUEST_WRITE_CHANGED');
          await assertRelations(); await assertRevocationAdmission(database,workspace.workspaceId,before);
          const updated = await database.get(`UPDATE ${prefix}.file_guest_invitations SET status='revoked',challenge_hash=NULL,
            policy_revision=policy_revision+1,updated_at=$3 WHERE id=$1 AND policy_revision=$2 AND status='active'
            RETURNING id,policy_revision`,[expected.id,expected.policyRevision,Date.now()]) as {id:string;policy_revision:number|string}|undefined;
          if (!updated) throw new FileGuestWriterError('FILE_GUEST_WRITE_CHANGED');
          await assertRelations(); await assertRevocationAdmission(database,workspace.workspaceId,before);
          return {id:updated.id,policyRevision:Number(updated.policy_revision),status:'revoked' as const};
        });
        prepared = true; return result;
      },
      recoverCommitted:async () => { throw new FileGuestWriterCommitError(); },
    }));
  } catch (error) { if (prepared) throw new FileGuestWriterCommitError(); throw error; }
}
