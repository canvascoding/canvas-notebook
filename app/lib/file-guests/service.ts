import 'server-only';

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { toDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { fileGuestInvitations as invitations, fileGuestSessions as sessions, user } from '@/app/lib/db/schema';
import { createCollaborationSessionGrant } from '@/app/lib/collaboration/session-service';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { readCurrentCollaborationDocument } from '@/app/lib/collaboration/document-access';
import { richMarkdownFromYDoc } from '@/app/lib/collaboration/markdown-state';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { resolveExistingWorkspacePath } from '@/app/lib/workspaces/path-guard';
import { readPostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { isSensitiveWorkspacePath, publicShareFileIdentityMatches } from '@/app/lib/public-sharing/public-file-shares';
import { collectPublicMarkdownImageWorkspacePaths } from '@/app/lib/public-sharing/public-markdown-images';
import { recordFileGuestVersion } from './versions';
import { fileGuestUrl, isFileGuestId, type FileGuestAsset, type FileGuestInvitationView, type FileGuestPermission } from './types';

export class FileGuestError extends Error {
  constructor(message: string, readonly status = 403) { super(message); this.name = 'FileGuestError'; }
}

type Invitation = typeof invitations.$inferSelect;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const active = (now = new Date()) => and(eq(invitations.status, 'active'), or(isNull(invitations.expiresAt), gt(invitations.expiresAt, now)));
const identity = (stats: Stats) => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
const MAX_TEXT = 5 * 1024 * 1024;

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

async function readInviterWorkspace(row: Invitation) {
  const [inviter] = await db.select().from(user).where(and(eq(user.id, row.createdByUserId),
    or(isNull(user.banned), eq(user.banned, false), lte(user.banExpires, new Date())))).limit(1);
  const workspace = inviter && await readPostgresWorkspaceForActor(resolveWorkspaceActor(inviter), row.workspaceId);
  if (!workspace) throw new FileGuestError('Der Einladende hat keinen Zugriff mehr.', 410);
  assertFileGuestManager(workspace, parseFileGuestPermission(row.permission));
  return workspace;
}

async function invitationDocument(row: Invitation, workspace: WorkspaceContext) {
  const metadata = await getFileCollaborationState({ workspace, path: row.path, ensureDocument: false });
  const state = await loadCollaborationState(row.documentId);
  if (!state || metadata.document?.id !== row.documentId || state.workspaceId !== row.workspaceId || state.path !== row.path
    || metadata.document.status !== 'active' || metadata.document.provider !== 'yjs') {
    throw new FileGuestError('Die Datei wurde verschoben, entfernt oder durch eine andere Datei ersetzt. Eine neue Einladung ist nötig.', 410);
  }
  // Deletion outside the file API must also stop an open guest connection.
  const stats = await fs.stat(await resolveExistingWorkspacePath(workspace, row.path)).catch(() => null);
  if (!stats?.isFile()) throw new FileGuestError('Die Datei ist nicht verfügbar.', 410);
  return state;
}

async function currentMarkdown(documentId: string, workspaceId: string, representation: string) {
  const markdown = await readCurrentCollaborationDocument({ documentId, workspaceId,
    read: (doc) => representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc) });
  if (Buffer.byteLength(markdown) > MAX_TEXT) throw new FileGuestError('Die Datei überschreitet 5 MiB.', 413);
  return markdown;
}

async function approveAssets(workspace: WorkspaceContext, filePath: string, markdown: string): Promise<FileGuestAsset[]> {
  const paths = [...collectPublicMarkdownImageWorkspacePaths(markdown, filePath, workspace.workspaceId)];
  if (paths.length > 100) throw new FileGuestError('Eine Einladung unterstützt höchstens 100 eingebettete Bilder.', 400);
  const assets: FileGuestAsset[] = [];
  for (const assetPath of paths) {
    if (isSensitiveWorkspacePath(assetPath)) continue;
    try {
      const stats = await fs.stat(await resolveExistingWorkspacePath(workspace, assetPath));
      if (stats.isFile() && stats.size <= 20 * 1024 * 1024) assets.push({ path: assetPath, identity: identity(stats) });
    } catch { /* Missing or out-of-root images do not become guest grants. */ }
  }
  return assets;
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
  assertEntitlement?: () => Promise<unknown>;
  sendCode?: typeof sendVerificationCode;
} = {}) {
  const assertEntitlement = dependencies.assertEntitlement ?? requireTeamRuntimeLicense;
  const sendCode = dependencies.sendCode ?? sendVerificationCode;

  async function activeInvitation(id: string) {
    await assertEntitlement();
    const row = await invitationById(id);
    assertInvitationActive(row);
    const workspace = await readInviterWorkspace(row);
    const state = await invitationDocument(row, workspace);
    return { row, workspace, state };
  }

  async function list(workspace: WorkspaceContext, filePath: string) {
    assertFileGuestManager(workspace);
    const rows = await db.select().from(invitations).where(and(eq(invitations.workspaceId, workspace.workspaceId), eq(invitations.path, filePath)))
      .orderBy(desc(invitations.createdAt)).limit(100);
    const metadata = await getFileCollaborationState({ workspace, path: filePath, ensureDocument: false });
    return rows.map((row) => invitationView(row, row.documentId !== metadata.document?.id));
  }

  async function create(input: { workspace: WorkspaceContext; path: string; email: string; permission: FileGuestPermission; expiresAt: Date | null }) {
    await assertEntitlement();
    assertFileGuestManager(input.workspace, input.permission);
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new FileGuestError('Eine gültige E-Mail-Adresse ist erforderlich.', 400);
    if (!/\.(md|markdown)$/iu.test(input.path) || isSensitiveWorkspacePath(input.path)) throw new FileGuestError('Gastzugang ist nur für Markdown-Dateien verfügbar.', 400);
    if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now())) throw new FileGuestError('Das Ablaufdatum muss in der Zukunft liegen.', 400);
    const stat = await fs.stat(await resolveExistingWorkspacePath(input.workspace, input.path));
    if (!stat.isFile() || stat.size > MAX_TEXT) throw new FileGuestError('Die Markdown-Datei darf höchstens 5 MiB groß sein.', 413);
    const grant = await createCollaborationSessionGrant({ workspace: input.workspace, fileOptions: { workspace: input.workspace }, request: { path: input.path, representation: 'auto', provider: 'yjs' } });
    const state = await loadCollaborationState(grant.documentId);
    if (!state) throw new FileGuestError('Die Datei ist noch nicht bereit.', 409);
    const markdown = await currentMarkdown(state.documentId, state.workspaceId, state.representation);
    const assets = await approveAssets(input.workspace, grant.path, markdown);
    // Preserve a recoverable baseline before anyone can join the invitation.
    await recordFileGuestVersion(state, true);
    const now = new Date();
    await db.update(invitations).set({ status: 'revoked', updatedAt: now, policyRevision: sql`${invitations.policyRevision} + 1` })
      .where(and(eq(invitations.workspaceId, input.workspace.workspaceId), eq(invitations.documentId, grant.documentId), eq(invitations.email, email), eq(invitations.status, 'active'), lte(invitations.expiresAt, now)));
    const [row] = await db.insert(invitations).values({ id: randomUUID(), workspaceId: input.workspace.workspaceId,
      path: grant.path, documentId: grant.documentId, email, permission: input.permission, expiresAt: input.expiresAt,
      createdByUserId: input.workspace.actor!.userId, assetsJson: JSON.stringify(assets), createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning();
    if (row) return invitationView(row);
    // A repeated create never changes another creator's policy.
    const [existing] = await db.select().from(invitations).where(and(eq(invitations.workspaceId, input.workspace.workspaceId), eq(invitations.documentId, grant.documentId), eq(invitations.email, email), active())).limit(1);
    if (!existing) throw new FileGuestError('Die Freigabe wurde gleichzeitig geändert. Bitte erneut laden.', 409);
    return invitationView(existing);
  }

  async function manage(workspace: WorkspaceContext, id: string, input: { policyRevision: number; permission?: FileGuestPermission; expiresAt?: Date | null; revoke?: boolean }) {
    assertFileGuestManager(workspace, input.permission);
    const row = await invitationById(id);
    if (row.workspaceId !== workspace.workspaceId) throw new FileGuestError('Einladung nicht gefunden.', 404);
    if (row.createdByUserId !== workspace.actor!.userId && !workspace.permissions.canManageWorkspace) throw new FileGuestError('Nur der Einladende oder die Workspace-Verwaltung kann diese Freigabe ändern.');
    if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) throw new FileGuestError('Eine gültige Version der Einstellungen ist erforderlich.', 400);
    if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now())) throw new FileGuestError('Das Ablaufdatum muss in der Zukunft liegen.', 400);
    const [updated] = await db.update(invitations).set({
      ...(input.permission ? { permission: input.permission } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.revoke ? { status: 'revoked', challengeHash: null } : {}),
      policyRevision: sql`${invitations.policyRevision} + 1`, updatedAt: new Date(),
    }).where(and(eq(invitations.id, id), eq(invitations.status, 'active'), eq(invitations.policyRevision, input.policyRevision))).returning();
    if (!updated) throw new FileGuestError('Die Einladung wurde bereits geändert oder widerrufen. Bitte neu laden.', 409);
    return invitationView(updated);
  }

  async function challenge(id: string) {
    const { row } = await activeInvitation(id);
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [updated] = await db.update(invitations).set({ challengeId, challengeHash: codeHash(id, challengeId, code),
      challengeExpiresAt: new Date(now.getTime() + 600_000), challengeAttempts: 0, challengeSentAt: now,
      challengeWindowAt: sql`CASE WHEN ${invitations.challengeWindowAt} IS NULL OR ${invitations.challengeWindowAt} <= ${toDatabaseTimestamp(hourAgo)} THEN ${toDatabaseTimestamp(now)} ELSE ${invitations.challengeWindowAt} END`,
      challengeSendCount: sql`CASE WHEN ${invitations.challengeWindowAt} IS NULL OR ${invitations.challengeWindowAt} <= ${toDatabaseTimestamp(hourAgo)} THEN 1 ELSE ${invitations.challengeSendCount} + 1 END`,
    }).where(and(eq(invitations.id, id), active(now),
      or(isNull(invitations.challengeSentAt), lte(invitations.challengeSentAt, new Date(now.getTime() - 60_000))),
      or(isNull(invitations.challengeWindowAt), lte(invitations.challengeWindowAt, hourAgo), lt(invitations.challengeSendCount, 5)),
    )).returning();
    if (!updated) throw new FileGuestError('Bitte warte vor einem weiteren Code. Pro Stunde sind höchstens fünf Codes möglich.', 429);
    try { await sendCode({ inviterId: row.createdByUserId, email: row.email, code, challengeId }); }
    catch (error) {
      await db.update(invitations).set({ challengeHash: null }).where(and(eq(invitations.id, id), eq(invitations.challengeId, challengeId)));
      if (error instanceof FileGuestError) throw error;
      throw new FileGuestError('Der Code konnte nicht gesendet werden. Bitte den Einladenden kontaktieren.', 503);
    }
  }

  async function verify(id: string, code: string, displayName: string) {
    if (!/^\d{6}$/u.test(code) || !displayName.trim() || displayName.trim().length > 80) throw new FileGuestError('Sechsstelligen Code und einen Namen mit höchstens 80 Zeichen eingeben.', 400);
    await activeInvitation(id);
    const now = new Date();
    const [attempt] = await db.update(invitations).set({ challengeAttempts: sql`${invitations.challengeAttempts} + 1` })
      .where(and(eq(invitations.id, id), active(now), gt(invitations.challengeExpiresAt, now), lt(invitations.challengeAttempts, 5))).returning();
    if (!attempt?.challengeId || !attempt.challengeHash) throw new FileGuestError('Der Code ist ungültig oder abgelaufen. Bitte einen neuen anfordern.', 401);
    const expected = Buffer.from(codeHash(id, attempt.challengeId, code), 'hex');
    const actual = Buffer.from(attempt.challengeHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new FileGuestError('Der Code ist ungültig oder abgelaufen.', 401);
    const consumed = await db.update(invitations).set({ challengeHash: null })
      .where(and(eq(invitations.id, id), active(), eq(invitations.challengeId, attempt.challengeId), eq(invitations.challengeHash, attempt.challengeHash))).returning({ id: invitations.id });
    if (!consumed.length) throw new FileGuestError('Dieser Code wurde bereits verwendet. Bitte einen neuen anfordern.', 401);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(Date.now() + 12 * 3_600_000, attempt.expiresAt?.getTime() ?? Infinity));
    await db.delete(sessions).where(and(eq(sessions.invitationId, id), lte(sessions.expiresAt, now)));
    await db.insert(sessions).values({ id: randomUUID(), invitationId: id, tokenHash: digest(token), displayName: displayName.trim(), expiresAt, createdAt: now });
    return { token, expiresAt };
  }

  async function access(id: string, credential: { token: string } | { sessionId: string }) {
    const { row, workspace, state } = await activeInvitation(id);
    if ('token' in credential && !/^[A-Za-z0-9_-]{43}$/u.test(credential.token)) throw new FileGuestError('Bitte bestätige zuerst deine E-Mail-Adresse.', 401);
    const [guestSession] = await db.select().from(sessions).where(and(eq(sessions.invitationId, id), gt(sessions.expiresAt, new Date()),
      'token' in credential ? eq(sessions.tokenHash, digest(credential.token)) : eq(sessions.id, credential.sessionId))).limit(1);
    if (!guestSession) throw new FileGuestError('Deine Gastsitzung ist abgelaufen. Bitte erneut per E-Mail bestätigen.', 401);
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
    const markdown = await currentMarkdown(found.state.documentId, found.workspace.workspaceId, found.state.representation);
    const checked = await access(id, { token });
    if (checked.invitation.policyRevision !== found.invitation.policyRevision || checked.state.lifecycleGeneration !== found.state.lifecycleGeneration) throw new FileGuestError('Die Freigabe wurde geändert. Bitte neu laden.', 409);
    return { ...checked, markdown, fileName: path.posix.basename(checked.invitation.path), assets: JSON.parse(checked.invitation.assetsJson) as FileGuestAsset[] };
  }

  async function asset(id: string, token: string, requestedPath: string) {
    const found = await access(id, { token });
    const allowed = (JSON.parse(found.invitation.assetsJson) as FileGuestAsset[]).find((entry) => entry.path === requestedPath);
    if (!allowed || isSensitiveWorkspacePath(requestedPath)) throw new FileGuestError('Bild nicht freigegeben.', 404);
    const handle = await fs.open(await resolveExistingWorkspacePath(found.workspace, requestedPath), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024 || !publicShareFileIdentityMatches(stat, allowed.identity)) throw new FileGuestError('Bild nicht mehr verfügbar.', 404);
      const bytes = await handle.readFile();
      const checked = await access(id, { token });
      if (checked.invitation.policyRevision !== found.invitation.policyRevision) throw new FileGuestError('Die Freigabe wurde geändert.', 409);
      return bytes;
    } finally { await handle.close(); }
  }

  async function logout(id: string, token: string) {
    await db.delete(sessions).where(and(eq(sessions.invitationId, id), eq(sessions.tokenHash, digest(token))));
  }

  return { list, create, manage, challenge, verify, access, content, asset, logout };
}

export const fileGuestService = createFileGuestService();
