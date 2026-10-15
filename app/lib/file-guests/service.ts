import 'server-only';

import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db, openDb, type SqlConnection } from '@/app/lib/db';
import { fileGuestInvitations as invitations, fileGuestSessions as sessions } from '@/app/lib/db/schema';
import { loadCollaborationStateOnConnection } from '@/app/lib/collaboration/persistence';
import { authoritativeNativeCollaborationSnapshot } from '@/app/lib/collaboration/document-snapshot';
import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { readPostgresWorkspaceForActorOnConnection } from '@/app/lib/workspaces/postgres-runtime';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { FileGuestInvitationAuthorityTarget } from '@/app/lib/workspaces/request-principal';
import { isSensitiveWorkspacePath } from '@/app/lib/public-sharing/public-file-shares';
import { withPreparedFileGuestInvitation } from './preparation';
import { revokeFileGuestInvitation, withFileGuestMemberWriter, withFileGuestInvitationReader, withFileGuestInvitationWriter, FileGuestWriterCommitError } from './writer';
import { redeemFileGuestCodeOnConnection } from './redemption';
import { recordFileGuestBaselineOnConnection } from './versions';
import { readApprovedFileGuestAsset } from './asset-reader';
import { captureFileGuestTarget, requireFileGuestDocumentBinding, FileGuestTargetError } from './target';
import { FILE_GUEST_CONTENT_LIMIT, type FileGuestContentBootstrap } from './content-contract';
import { fileGuestUrl, isFileGuestId, type FileGuestAsset, type FileGuestInvitationView, type FileGuestPermission } from './types';

export class FileGuestError extends Error {
  constructor(message: string, readonly status = 403) { super(message); this.name = 'FileGuestError'; }
}

type Invitation = typeof invitations.$inferSelect;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const invitationColumns = `id,workspace_id AS "workspaceId",path,document_id AS "documentId",
  lineage_id AS "lineageId",lifecycle_generation AS "lifecycleGeneration",email,permission,status,
  policy_revision AS "policyRevision",created_by_user_id AS "createdByUserId",assets_json AS "assetsJson",
  expires_at AS "expiresAt",created_at AS "createdAt",updated_at AS "updatedAt",challenge_id AS "challengeId",
  challenge_hash AS "challengeHash",challenge_expires_at AS "challengeExpiresAt",challenge_attempts AS "challengeAttempts",
  challenge_sent_at AS "challengeSentAt",challenge_window_at AS "challengeWindowAt",challenge_send_count AS "challengeSendCount"`;

function mapInvitation(row: Record<string, unknown>): Invitation {
  const date = (value: unknown) => value === null ? null : new Date(Number(value));
  return { ...row, lifecycleGeneration: row.lifecycleGeneration === null ? null : Number(row.lifecycleGeneration),
    policyRevision: Number(row.policyRevision), challengeAttempts: Number(row.challengeAttempts), challengeSendCount: Number(row.challengeSendCount),
    expiresAt: date(row.expiresAt),createdAt: date(row.createdAt),updatedAt: date(row.updatedAt),
    challengeExpiresAt: date(row.challengeExpiresAt),challengeSentAt: date(row.challengeSentAt),challengeWindowAt: date(row.challengeWindowAt),
  } as Invitation;
}

async function readInvitationOnConnection(database: SqlConnection, id: string): Promise<Invitation> {
  const row = await database.get(`SELECT ${invitationColumns} FROM file_guest_invitations WHERE id=$1`,[id]) as Record<string,unknown> | undefined;
  if (!row) throw new FileGuestError('Diese Einladung ist nicht verfügbar.',404);
  return mapInvitation(row);
}

function assertInvitationTarget(row: Invitation, target: FileGuestInvitationAuthorityTarget): void {
  if (Object.keys(target).some(key => Reflect.get(row,key) !== Reflect.get(target,key))) {
    throw new FileGuestError('Die Einladung wurde zwischenzeitlich geändert. Bitte erneut laden.',409);
  }
}

export function assertFileGuestManager(workspace: WorkspaceContext, permission: FileGuestPermission = 'read') {
  if (workspace.legacy || !workspace.actor || !workspace.permissions.canRead || !workspace.permissions.canCreatePublicLinks
    || (permission === 'write' && !workspace.permissions.canWrite)) {
    throw new FileGuestError('Zum Einladen fehlen die Freigabe- oder Schreibrechte.');
  }
}

export function parseFileGuestPermission(value: unknown): FileGuestPermission {
  if (value !== 'read' && value !== 'write') throw new FileGuestError('Lesen oder Bearbeiten auswählen.', 400);
  return value;
}

function invitationView(row: Invitation, unavailable = false): FileGuestInvitationView {
  return {
    id: row.id, path: row.path, email: row.email, permission: parseFileGuestPermission(row.permission),
    status: row.status !== 'active' ? 'revoked' : row.expiresAt && row.expiresAt.getTime() <= Date.now() ? 'expired' : unavailable ? 'unavailable' : 'active',
    expiresAt: row.expiresAt?.toISOString() ?? null, policyRevision: row.policyRevision,
    createdAt: row.createdAt.toISOString(), createdByUserId: row.createdByUserId,
    url: fileGuestUrl(row.id), assetCount: (JSON.parse(row.assetsJson) as FileGuestAsset[]).length,
  };
}

async function invitationById(id: string): Promise<Invitation> {
  if (!isFileGuestId(id)) throw new FileGuestError('Diese Einladung ist nicht verfügbar.', 404);
  const [row] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
  if (!row) throw new FileGuestError('Diese Einladung ist nicht verfügbar.', 404);
  return row;
}

function assertInvitationActive(row: Invitation) {
  if (row.status !== 'active' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
    throw new FileGuestError('Diese Einladung ist abgelaufen oder wurde widerrufen.', 410);
  }
}

async function readInviterWorkspace(database: SqlConnection, row: Invitation,
  license: Awaited<ReturnType<typeof requireTeamRuntimeLicense>>) {
  // The genuine member Principal already holds SHARE on the auth/ACL tables.
  // Read the original inviter from those same stable relations, never a caller actor.
  const inviter = await database.get('SELECT id,email,role,banned FROM "user" WHERE id=$1',[row.createdByUserId]) as {
    id:string;email:string|null;role:string|null;banned:boolean|number|string|null;
  } | undefined;
  if (!inviter || inviter.id !== row.createdByUserId || ![null,false,0,'0'].includes(inviter.banned as never)) {
    throw new FileGuestError('Der Einladende hat keinen Zugriff mehr.',410);
  }
  await assertUserSeatAccess({userId:row.createdByUserId,database,licenseStatus:license});
  const workspace = await readPostgresWorkspaceForActorOnConnection(database,resolveWorkspaceActor(inviter),row.workspaceId);
  if (!workspace) throw new FileGuestError('Der Einladende hat keinen Zugriff mehr.', 410);
  assertFileGuestManager(workspace, parseFileGuestPermission(row.permission));
  return workspace;
}

async function invitationDocument(database: SqlConnection, row: Invitation, workspace: WorkspaceContext) {
  requireFileGuestDocumentBinding(row);
  const state = await loadCollaborationStateOnConnection(database,row.documentId);
  if (!state || state.workspaceId !== row.workspaceId || state.organizationId !== (workspace.organizationId ?? null)
    || state.path !== row.path || state.lifecycleGeneration !== row.lifecycleGeneration || state.status !== 'active') {
    throw new FileGuestError('Die Datei wurde verschoben, entfernt oder durch eine andere Datei ersetzt. Eine neue Einladung ist nötig.', 410);
  }
  // The central reader has compared native catalog/lineage/generation on B.
  // A Markdown projection is optional and never establishes guest authority.
  return state;
}

async function sendVerificationCode(input: { inviterId: string; email: string; code: string; challengeId: string }) {
  const { getSystemSmtpConfigurationStatus } = await import('@/app/lib/email/system-smtp-config');
  const configuration = await getSystemSmtpConfigurationStatus();
  const message = {
    purpose: 'email_verification' as const, to: [input.email], subject: 'Canvas Notebook: Code für deinen Dateizugang',
    body: `Dein Code: ${input.code}\n\nEr gilt 10 Minuten für den angeforderten Dateizugang. Teile ihn nicht mit anderen. Falls du keinen Code angefordert hast, kannst du diese Nachricht ignorieren.`,
    idempotencyKey: input.challengeId,
  };
  if (configuration.deliveryMode === 'managed' && configuration.managedAvailable) {
    const { sendManagedSystemEmail } = await import('@/app/lib/email/managed-system-email-client');
    await sendManagedSystemEmail(message);
  } else if (configuration.deliveryMode === 'local' && configuration.configured) {
    const { sendSystemSmtpEmail } = await import('@/app/lib/email/system-smtp-service');
    await sendSystemSmtpEmail(message);
  } else throw new FileGuestError('System-E-Mail ist nicht eingerichtet. Der Einladende muss sie unter /settings?tab=integrations konfigurieren.', 503);
}

function codeHash(id: string, challengeId: string, code: string) {
  const secret = process.env.CANVAS_COLLABORATION_TICKET_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new FileGuestError('Die Server-Authentifizierung ist nicht eingerichtet.', 503);
  return createHmac('sha256', secret).update(`file-guest\0${id}\0${challengeId}\0${code}`).digest('hex');
}

/** Dependencies allow isolated verification tests without sending real email. */
export function createFileGuestService(dependencies: {
  sendCode?: typeof sendVerificationCode;
} = {}) {
  const sendCode = dependencies.sendCode ?? sendVerificationCode;

  async function list(workspace: WorkspaceContext, filePath: string) {
    assertFileGuestManager(workspace);
    const rows = await db.select().from(invitations).where(and(eq(invitations.workspaceId, workspace.workspaceId), eq(invitations.path, filePath)))
      .orderBy(desc(invitations.createdAt)).limit(100);
    const database = await openDb();
    try {
      const current = await database.get(`SELECT d.id,d.lineage_id,s.lifecycle_generation FROM collaboration_documents d
        JOIN file_collaboration_lineages l ON l.id=d.lineage_id JOIN collaboration_yjs_states s ON s.document_id=d.id
        WHERE d.workspace_id=$1 AND d.path=$2 AND d.status='active' AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized'
          AND l.workspace_id=d.workspace_id AND l.path=d.path AND l.status='active'
          AND s.workspace_id=d.workspace_id AND s.path=d.path AND s.status='active'`,[workspace.workspaceId,filePath]) as {
          id:string;lineage_id:string;lifecycle_generation:number|string;
        } | undefined;
      return rows.map(row => invitationView(row,!current || row.documentId !== current.id || row.lineageId !== current.lineage_id
        || row.lifecycleGeneration !== Number(current.lifecycle_generation)));
    } finally { await database.close(); }
  }

  async function create(request: NextRequest, input: { workspaceId:string; path:string; expectedTarget:unknown;
    email:string; permission:FileGuestPermission; expiresAt:Date|null }) {
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new FileGuestError('Eine gültige E-Mail-Adresse ist erforderlich.', 400);
    const permission = parseFileGuestPermission(input.permission), expiresMs = input.expiresAt?.getTime() ?? null;
    if (expiresMs !== null && (!Number.isFinite(expiresMs) || expiresMs <= Date.now())) throw new FileGuestError('Das Ablaufdatum muss in der Zukunft liegen.',400);
    if (isSensitiveWorkspacePath(input.path)) throw new FileGuestError('Diese Datei kann nicht für Gäste freigegeben werden.',400);
    const selection = Object.freeze({workspaceId:input.workspaceId,path:input.path,
      expectedTarget:captureFileGuestTarget(input.expectedTarget,input.workspaceId,input.path),operationId:`guest-invite-${randomUUID()}`});
    await requireTeamRuntimeLicense();
    return withPreparedFileGuestInvitation(request,selection,prepared => withFileGuestMemberWriter(request,
      {workspaceId:selection.workspaceId,expectedTarget:prepared.target,permission},async access => {
        const {database,target} = access;
        await prepared.assertCurrent(database); await access.assertCurrent();
        await recordFileGuestBaselineOnConnection(database,target);
        const now = Date.now();
        if (expiresMs !== null && expiresMs <= now) throw new FileGuestError('Das Ablaufdatum muss in der Zukunft liegen.',400);
        // Retiring expired grants cannot rebind them. Future/foreign pins remain a conflict.
        await database.run(`UPDATE file_guest_invitations SET status='revoked',challenge_hash=NULL,
          policy_revision=policy_revision+1,updated_at=$4 WHERE workspace_id=$1 AND document_id=$2 AND email=$3
          AND status='active' AND expires_at<=$4 AND ((lineage_id IS NULL AND lifecycle_generation IS NULL)
            OR (lineage_id=$5 AND lifecycle_generation<=$6))`,
        [selection.workspaceId,target.documentId,email,now,target.lineageId,target.lifecycleGeneration]);
        const inserted = await database.get(`INSERT INTO file_guest_invitations
          (id,workspace_id,path,document_id,lineage_id,lifecycle_generation,email,permission,expires_at,created_by_user_id,assets_json,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT DO NOTHING RETURNING ${invitationColumns}`,
        [randomUUID(),selection.workspaceId,target.path,target.documentId,target.lineageId,target.lifecycleGeneration,email,permission,
          expiresMs,access.userId,JSON.stringify(prepared.assets),now]) as Record<string,unknown> | undefined;
        let row: Invitation;
        if (inserted) row = mapInvitation(inserted);
        else {
          const existing = await database.get(`SELECT ${invitationColumns} FROM file_guest_invitations
            WHERE workspace_id=$1 AND document_id=$2 AND email=$3 AND status='active' FOR UPDATE`,
          [selection.workspaceId,target.documentId,email]) as Record<string,unknown> | undefined;
          if (!existing) throw new FileGuestError('Die Freigabe wurde gleichzeitig geändert. Bitte erneut laden.',409);
          row = mapInvitation(existing);
          // A repeated create may only return this creator's still usable exact native grant.
          if (row.createdByUserId !== access.userId || row.path !== target.path || row.lineageId !== target.lineageId
            || row.lifecycleGeneration !== target.lifecycleGeneration
            || row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
            throw new FileGuestError('Es besteht bereits eine andere oder veraltete Einladung. Bitte diese prüfen, widerrufen und anschließend neu einladen.',409);
          }
          // Repeated Create reports the existing policy unchanged. Even when
          // requesting read, returning a write grant needs current write rights.
          assertFileGuestManager(access.workspace,parseFileGuestPermission(row.permission));
        }
        await prepared.assertCurrent(database); await access.assertCurrent();
        return invitationView(row);
      }));
  }

  async function manage(request:NextRequest, workspaceId:string, id:string,
    input:{policyRevision:number;permission?:FileGuestPermission;expiresAt?:Date|null;revoke?:boolean}) {
    const policyRevision = input.policyRevision, permission = input.permission === undefined ? undefined : parseFileGuestPermission(input.permission);
    const expiresMs = input.expiresAt === undefined ? undefined : input.expiresAt?.getTime() ?? null, revoke = input.revoke === true;
    if (!Number.isSafeInteger(policyRevision) || policyRevision < 1) throw new FileGuestError('Eine gültige Version der Einstellungen ist erforderlich.',400);
    if (expiresMs != null && (!Number.isFinite(expiresMs) || expiresMs <= Date.now())) throw new FileGuestError('Das Ablaufdatum muss in der Zukunft liegen.',400);
    const row = await invitationById(id);
    if (row.workspaceId !== workspaceId) throw new FileGuestError('Einladung nicht gefunden.',404);
    if (revoke) {
      const result = await revokeFileGuestInvitation(request,{workspaceId,id,policyRevision});
      return invitationView({...row,status:'revoked',policyRevision:result.policyRevision});
    }
    requireFileGuestDocumentBinding(row);
    const effectivePermission = permission ?? parseFileGuestPermission(row.permission);
    const license = await requireTeamRuntimeLicense();
    return withFileGuestMemberWriter(request,{workspaceId,permission:effectivePermission,
      expectedTarget:{version:1,kind:'native_file',workspaceId,path:row.path,documentId:row.documentId,lifecycleGeneration:row.lifecycleGeneration}},async access => {
        await access.database.get('SELECT id FROM file_guest_invitations WHERE id=$1 FOR UPDATE',[id]);
        const current = await readInvitationOnConnection(access.database,id);
        if (current.workspaceId !== workspaceId || current.path !== access.target.path || current.documentId !== access.target.documentId
          || current.lineageId !== access.target.lineageId || current.lifecycleGeneration !== access.target.lifecycleGeneration
          || current.policyRevision !== policyRevision || current.status !== 'active') throw new FileGuestTargetError('FILE_GUEST_TARGET_CHANGED');
        if (current.createdByUserId !== access.userId && !access.workspace.permissions.canManageWorkspace) {
          throw new FileGuestError('Nur der Einladende oder die Workspace-Verwaltung kann diese Freigabe ändern.');
        }
        await readInviterWorkspace(access.database,{...current,permission:effectivePermission},license);
        if (expiresMs != null && expiresMs <= Date.now()) throw new FileGuestError('Das Ablaufdatum muss in der Zukunft liegen.',400);
        await access.assertCurrent();
        const updated = await access.database.get(`UPDATE file_guest_invitations SET permission=$3,
          expires_at=CASE WHEN $4::boolean THEN $5::bigint ELSE expires_at END,challenge_hash=NULL,
          policy_revision=policy_revision+1,updated_at=$6 WHERE id=$1 AND policy_revision=$2 AND status='active'
          RETURNING ${invitationColumns}`,[id,policyRevision,effectivePermission,expiresMs !== undefined,expiresMs ?? null,Date.now()]) as Record<string,unknown> | undefined;
        if (!updated) throw new FileGuestError('Die Einladung wurde bereits geändert oder widerrufen. Bitte neu laden.',409);
        await access.assertCurrent();
        return invitationView(mapInvitation(updated));
      });
  }

  async function challenge(id: string) {
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challengeHash = codeHash(id,challengeId,code);
    const committed = await withFileGuestInvitationWriter(id,'challenge',async access => {
      const row = await readInvitationOnConnection(access.database,id);
      assertInvitationTarget(row,access.invitation);
      const now = Date.now(), hourAgo = now-3_600_000;
      await access.assertCurrent();
      const updated = await access.database.get(`UPDATE file_guest_invitations SET challenge_id=$2,challenge_hash=$3,
        challenge_expires_at=$4,challenge_attempts=0,challenge_sent_at=$5,
        challenge_window_at=CASE WHEN challenge_window_at IS NULL OR challenge_window_at<=$6 THEN $5 ELSE challenge_window_at END,
        challenge_send_count=CASE WHEN challenge_window_at IS NULL OR challenge_window_at<=$6 THEN 1 ELSE challenge_send_count+1 END
        WHERE id=$1 AND status='active' AND policy_revision=$7 AND lineage_id=$8 AND lifecycle_generation=$9
          AND (expires_at IS NULL OR expires_at>$5) AND (challenge_sent_at IS NULL OR challenge_sent_at<=$10)
          AND (challenge_window_at IS NULL OR challenge_window_at<=$6 OR challenge_send_count<5) RETURNING id`,
      [id,challengeId,challengeHash,now+600_000,now,hourAgo,access.invitation.policyRevision,
        access.invitation.lineageId,access.invitation.lifecycleGeneration,now-60_000]);
      if (!updated) throw new FileGuestError('Bitte warte vor einem weiteren Code. Pro Stunde sind höchstens fünf Codes möglich.',429);
      await access.assertCurrent();
      return {invitation:access.invitation,email:row.email};
    });
    // Outbound delivery occurs only after the actual writer COMMIT and release.
    try { await sendCode({ inviterId:committed.invitation.createdByUserId,email:committed.email,code,challengeId }); }
    catch (error) {
      try {
        await withFileGuestInvitationWriter(id,'failed_challenge_cleanup',async access => {
          if (Object.keys(committed.invitation).some(key => Reflect.get(committed.invitation,key) !== Reflect.get(access.invitation,key))) return;
          await access.assertCurrent();
          // A fresh policy or later challenge can never be cleared by this delivery failure.
          await access.database.run(`UPDATE file_guest_invitations SET challenge_hash=NULL WHERE id=$1 AND status='active'
            AND policy_revision=$2 AND lineage_id=$3 AND lifecycle_generation=$4 AND challenge_id=$5 AND challenge_hash=$6`,
          [id,committed.invitation.policyRevision,committed.invitation.lineageId,committed.invitation.lifecycleGeneration,challengeId,challengeHash]);
          await access.assertCurrent();
        });
      } catch (cleanupError) {
        if (cleanupError instanceof FileGuestWriterCommitError) throw cleanupError;
        // Revocation/rights loss can close this fresh authority. Never use a
        // global fallback write, disclose the credential or repeat the send.
        console.warn('[FileGuests] Challenge cleanup unavailable',{name:cleanupError instanceof Error ? cleanupError.name : typeof cleanupError});
      }
      if (error instanceof FileGuestError) throw error;
      throw new FileGuestError('Der Code konnte nicht gesendet werden. Bitte den Einladenden kontaktieren.', 503);
    }
  }

  async function verify(id: string, code: string, displayName: string) {
    if (!/^\d{6}$/u.test(code) || !displayName.trim() || displayName.trim().length > 80) throw new FileGuestError('Sechsstelligen Code und einen Namen mit höchstens 80 Zeichen eingeben.', 400);
    const name = displayName.trim();
    const result = await withFileGuestInvitationWriter(id,'redeem',access => redeemFileGuestCodeOnConnection(access.database,
      {invitation:access.invitation,displayName:name,hashCode:challengeId => codeHash(id,challengeId,code)}));
    if (result.kind === 'changed') throw new FileGuestError('Die Einladung wurde zwischenzeitlich geändert. Bitte erneut laden.', 409);
    if (result.kind === 'expired') throw new FileGuestError('Diese Einladung ist abgelaufen oder wurde widerrufen.', 410);
    if (result.kind === 'invalid') throw new FileGuestError('Der Code ist ungültig oder abgelaufen. Bitte einen neuen anfordern.', 401);
    return { token: result.token, expiresAt: result.expiresAt };
  }

  async function access(id: string, credential: { token: string } | { sessionId: string }) {
    if ('token' in credential && !/^[A-Za-z0-9_-]{43}$/u.test(credential.token)) throw new FileGuestError('Bitte bestätige zuerst deine E-Mail-Adresse.', 401);
    const selector = 'token' in credential ? {column:'token_hash',value:digest(credential.token)} : {column:'id',value:credential.sessionId};
    if (typeof selector.value !== 'string' || selector.value.length > 256 || !selector.value) throw new FileGuestError('Bitte bestätige zuerst deine E-Mail-Adresse.',401);
    const {row,workspace,state,guestSession} = await withFileGuestInvitationReader(id,async held => {
      const row = await readInvitationOnConnection(held.database,id);
      assertInvitationTarget(row,held.invitation); assertInvitationActive(row);
      const state = await invitationDocument(held.database,row,held.workspace);
      const raw = await held.database.get(`SELECT id,invitation_id,token_hash,display_name,expires_at,created_at
        FROM file_guest_sessions WHERE invitation_id=$1 AND ${selector.column}=$2 AND expires_at>$3`,
      [id,selector.value,Date.now()]) as {id:string;invitation_id:string;token_hash:string;display_name:string;expires_at:number|string;created_at:number|string} | undefined;
      if (!raw) throw new FileGuestError('Deine Gastsitzung ist abgelaufen. Bitte erneut per E-Mail bestätigen.',401);
      const guestSession: typeof sessions.$inferSelect = {id:raw.id,invitationId:raw.invitation_id,tokenHash:raw.token_hash,
        displayName:raw.display_name,expiresAt:new Date(Number(raw.expires_at)),createdAt:new Date(Number(raw.created_at))};
      await held.assertCurrent();
      return {row,workspace:held.workspace,state,guestSession};
    });
    const guestUserId = `guest:${id}`;
    // This context only leaves this service for file-scoped collaboration operations.
    // It is never accepted by requireRequestWorkspace or general file/agent routes.
    const scopedWorkspace: WorkspaceContext = { ...workspace, actor: { userId: guestUserId, role: 'external' }, permissions: {
      canRead: true, canWrite: row.permission === 'write', canDelete: false,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false,
    } };
    return { invitation: row, workspace: scopedWorkspace, state, guestSession,
      user: { id: guestUserId, name: `${guestSession.displayName} (Gast)`, email: null, role: 'external' } };
  }

  async function content(id: string, token: string) {
    const found = await access(id, { token });
    const snapshot = authoritativeNativeCollaborationSnapshot(found.state);
    if (Buffer.byteLength(JSON.stringify(snapshot.content)) > FILE_GUEST_CONTENT_LIMIT) throw new FileGuestError('Der Dokumentinhalt überschreitet 5 MiB.',413);
    const bootstrap: FileGuestContentBootstrap = {kind:'native_document',content:snapshot.content};
    return {...found,bootstrap,fileName:path.posix.basename(found.invitation.path),assets:JSON.parse(found.invitation.assetsJson) as FileGuestAsset[]};
  }

  async function asset(id: string, token: string, requestedPath: string) {
    const found = await access(id, { token });
    const allowed = (JSON.parse(found.invitation.assetsJson) as FileGuestAsset[]).find((entry) => entry.path === requestedPath);
    if (!allowed || isSensitiveWorkspacePath(requestedPath)) throw new FileGuestError('Bild nicht freigegeben.', 404);
    requireFileGuestDocumentBinding(found.invitation);
    const target: FileGuestInvitationAuthorityTarget = {id,workspaceId:found.invitation.workspaceId,path:found.invitation.path,
      documentId:found.invitation.documentId,lineageId:found.invitation.lineageId,lifecycleGeneration:found.invitation.lifecycleGeneration,
      policyRevision:found.invitation.policyRevision,permission:parseFileGuestPermission(found.invitation.permission),createdByUserId:found.invitation.createdByUserId};
    const verifyCurrent = async () => {
      const checked = await access(id, { token });
      assertInvitationTarget(checked.invitation,target);
      if (['workspaceId','workspaceType','organizationId','rootPath','rootRelativePath'].some(key =>
        (Reflect.get(checked.workspace,key) ?? null) !== (Reflect.get(found.workspace,key) ?? null))
        || !(JSON.parse(checked.invitation.assetsJson) as FileGuestAsset[]).some(entry => entry.path === allowed.path && entry.identity === allowed.identity)) {
        throw new FileGuestError('Die Bildfreigabe wurde geändert. Bitte neu laden.',409);
      }
    };
    return Buffer.from(await readApprovedFileGuestAsset(found.workspace,allowed,verifyCurrent));
  }

  async function logout(id: string, token: string) {
    await db.delete(sessions).where(and(eq(sessions.invitationId, id), eq(sessions.tokenHash, digest(token))));
  }

  return { list, create, manage, challenge, verify, access, content, asset, logout };
}

export const fileGuestService = createFileGuestService();
