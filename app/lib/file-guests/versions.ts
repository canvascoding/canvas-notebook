import 'server-only';
import { isRichTextCollaborationRepresentation } from '@/app/lib/collaboration/types';

import { createHash, randomUUID } from 'node:crypto';
import type { Doc } from 'yjs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { fileGuestInvitations, fileGuestVersions } from '@/app/lib/db/schema';
import { Y } from '@/app/lib/collaboration/server-runtime';
import { richMarkdownFromYDoc, replaceRichMarkdownInYDoc } from '@/app/lib/collaboration/markdown-state';
import { loadCollaborationState, type PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import { readCurrentCollaborationDocument } from '@/app/lib/collaboration/document-access';
import { runCollaborationDirectConnection } from '@/app/lib/collaboration/direct-connection';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export class FileGuestVersionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** Keep twenty recovery points; normal saves add at most one point per minute. */
export async function recordFileGuestVersion(state: PersistedCollaborationState, force = false) {
  if (!force) {
    const [invitation] = await db.select({ id: fileGuestInvitations.id }).from(fileGuestInvitations)
      .where(eq(fileGuestInvitations.documentId, state.documentId)).limit(1);
    if (!invitation) return;
  }
  const [latest] = await db.select().from(fileGuestVersions).where(eq(fileGuestVersions.documentId, state.documentId))
    .orderBy(desc(fileGuestVersions.createdAt), desc(fileGuestVersions.id)).limit(1);
  if (!force && latest && Date.now() - latest.createdAt.getTime() < 60_000) return;
  const readContent = (doc: Doc) => state.representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc);
  let content: string;
  if (force) {
    // Explicit restore backups still include not-yet-persisted live edits.
    content = await readCurrentCollaborationDocument({ documentId: state.documentId, workspaceId: state.workspaceId, read: readContent });
  } else {
    // A delayed background export must not label a newer live document with
    // this older snapshot's generation and sequence.
    const snapshot = new Y.Doc();
    try { Y.applyUpdate(snapshot, state.yjsState); content = readContent(snapshot); }
    finally { snapshot.destroy(); }
  }
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new FileGuestVersionError('Versionsstand überschreitet 5 MiB.', 413);
  const contentHash = createHash('sha256').update(content).digest('hex');
  if (latest?.contentHash === contentHash) return;
  await db.insert(fileGuestVersions).values({ id: randomUUID(), workspaceId: state.workspaceId, documentId: state.documentId,
    lifecycleGeneration: state.lifecycleGeneration, documentSequence: state.documentSequence,
    content, contentHash, createdAt: new Date(),
  }).onConflictDoNothing();
  const expired = await db.select({ id: fileGuestVersions.id }).from(fileGuestVersions).where(eq(fileGuestVersions.documentId, state.documentId))
    .orderBy(desc(fileGuestVersions.createdAt), desc(fileGuestVersions.id)).offset(20).limit(100);
  if (expired.length) await db.delete(fileGuestVersions).where(inArray(fileGuestVersions.id, expired.map((row) => row.id)));
}

async function managedDocument(workspace: WorkspaceContext, path: string) {
  if (!workspace.actor || !workspace.permissions.canRead || !workspace.permissions.canWrite
    || !workspace.permissions.canCreatePublicLinks) throw new FileGuestVersionError('Schreib- und Freigaberechte sind erforderlich.', 403);
  const metadata = await getFileCollaborationState({ workspace, path, ensureDocument: false });
  const state = metadata.document && await loadCollaborationState(metadata.document.id);
  if (!state || state.workspaceId !== workspace.workspaceId || state.path !== path) throw new FileGuestVersionError('Dokument nicht verfügbar.', 404);
  return state;
}

export async function listFileGuestVersions(workspace: WorkspaceContext, path: string) {
  const state = await managedDocument(workspace, path);
  const versions = await db.select({ id: fileGuestVersions.id, createdAt: fileGuestVersions.createdAt,
    lifecycleGeneration: fileGuestVersions.lifecycleGeneration, documentSequence: fileGuestVersions.documentSequence,
  }).from(fileGuestVersions).where(and(eq(fileGuestVersions.documentId, state.documentId), eq(fileGuestVersions.workspaceId, workspace.workspaceId)))
    .orderBy(desc(fileGuestVersions.createdAt), desc(fileGuestVersions.id)).limit(20);
  const stateFingerprint = await readCurrentCollaborationDocument({ documentId: state.documentId, workspaceId: state.workspaceId,
    read: (doc) => createHash('sha256').update(Y.encodeStateAsUpdate(doc)).digest('hex') });
  return { versions, stateFingerprint };
}

export async function readFileGuestVersion(workspace: WorkspaceContext, path: string, versionId: string) {
  const state = await managedDocument(workspace, path);
  const [version] = await db.select({ id: fileGuestVersions.id, content: fileGuestVersions.content, createdAt: fileGuestVersions.createdAt })
    .from(fileGuestVersions).where(and(eq(fileGuestVersions.id, versionId), eq(fileGuestVersions.documentId, state.documentId),
      eq(fileGuestVersions.workspaceId, workspace.workspaceId))).limit(1);
  if (!version) throw new FileGuestVersionError('Versionsstand nicht gefunden.', 404);
  return version;
}

export async function restoreFileGuestVersion(input: { workspace: WorkspaceContext; path: string; versionId: string; stateFingerprint: string; sessionId: string }) {
  const state = await managedDocument(input.workspace, input.path);
  const [version] = await db.select().from(fileGuestVersions).where(and(eq(fileGuestVersions.id, input.versionId),
    eq(fileGuestVersions.documentId, state.documentId), eq(fileGuestVersions.workspaceId, input.workspace.workspaceId))).limit(1);
  if (!version) throw new FileGuestVersionError('Versionsstand nicht gefunden.', 404);
  if (!/^[a-f\d]{64}$/u.test(input.stateFingerprint)) throw new FileGuestVersionError('Aktuellen Versionsstand neu laden.', 400);
  // A durable backup is required before restoring. The fingerprint guard inside the
  // live transaction rejects any edit that arrived while the backup was made.
  await recordFileGuestVersion(state, true);
  await runCollaborationDirectConnection({ documentId: state.documentId, documentPath: state.path,
    documentRepresentation: state.representation, documentLifecycleGeneration: state.lifecycleGeneration,
    documentSchemaVersion: state.schemaVersion, requiresFileCheckpointIdentity: true,
    workspace: input.workspace, actorId: input.workspace.actor!.userId, actorDisplayName: 'Versionswiederherstellung',
    initiatedByUserId: input.workspace.actor!.userId, operationId: `restore:${version.id}`, actorType: 'user', actorSessionId: input.sessionId,
  }, (doc) => {
    if (createHash('sha256').update(Y.encodeStateAsUpdate(doc)).digest('hex') !== input.stateFingerprint) throw new FileGuestVersionError('Die Datei wurde inzwischen bearbeitet. Aktuellen Stand laden und die Wiederherstellung erneut prüfen.');
    if (isRichTextCollaborationRepresentation(state.representation)) replaceRichMarkdownInYDoc(doc, version.content, 'version_restore');
    else doc.transact(() => {
      const text = doc.getText('content');
      text.delete(0, text.length);
      text.insert(0, version.content);
    }, 'version_restore');
  });
}
