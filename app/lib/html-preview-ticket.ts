import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { session as authSession, user as authUser } from '@/app/lib/db/schema';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { createStudioScope } from '@/app/lib/integrations/studio-scope';
import { canReadStudioMediaPath } from '@/app/lib/integrations/studio-media-access';
import { resolveValidatedStudioPath } from '@/app/lib/integrations/studio-paths';
import { getStudioRoot } from '@/app/lib/integrations/studio-workspace';
import { getFileStats, listDirectory, readFile } from '@/app/lib/filesystem/workspace-files';
import type { RequestWorkspaceSession } from '@/app/lib/workspaces/request';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolveExistingPostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { buildHtmlPreviewAssetManifest, normalizeHtmlPreviewPath, type HtmlPreviewAssetReader } from './html-preview-assets';

export const HTML_PREVIEW_TICKET_TTL_MS = 30 * 60 * 1000;
export const HTML_PREVIEW_ROUTE_PREFIX = '/__preview';
const MAX_TICKETS = 1024;
const MAX_TICKETS_PER_SESSION = 16;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

export type HtmlPreviewKind = 'workspace' | 'studio';
type PreviewRecord = {
  sessionId: string;
  userId: string;
  workspaceId: string;
  rootHtmlPath: string;
  kind: HtmlPreviewKind;
  assets: ReadonlySet<string>;
  expiresAt: number;
};
const runtime = globalThis as typeof globalThis & { __canvasHtmlPreviewTickets?: Map<string, PreviewRecord> };
function tickets() { return runtime.__canvasHtmlPreviewTickets ??= new Map(); }
function ticketKey(ticket: string) { return createHash('sha256').update(ticket).digest('hex'); }

async function resolvePreviewStudioPath(filePath: string, workspace: WorkspaceContext, userId: string) {
  normalizeHtmlPreviewPath(filePath);
  if (!await canReadStudioMediaPath(filePath, createStudioScope(userId, workspace))) throw new Error('Preview asset unavailable');
  const fullPath = resolveValidatedStudioPath(filePath);
  if (!fullPath) throw new Error('Preview asset unavailable');
  const [realRoot, realFile] = await Promise.all([fs.realpath(getStudioRoot()), fs.realpath(fullPath)]);
  // A readable logical Studio path cannot be a symlink into another workspace
  // or the host. A symlink for the configured data root itself remains valid.
  if (realFile !== path.resolve(realRoot, path.relative(getStudioRoot(), fullPath))) throw new Error('Preview asset unavailable');
  return realFile;
}

/** Every file operation keeps the normal filesystem and Studio access guards. */
export function htmlPreviewAssetReader(workspace: WorkspaceContext, userId: string, kind: HtmlPreviewKind): HtmlPreviewAssetReader {
  if (kind === 'workspace') return {
    async read(filePath) {
      normalizeHtmlPreviewPath(filePath);
      const stats = await getFileStats(filePath, { workspace });
      if (stats.size > MAX_SOURCE_BYTES) throw new Error('HTML preview source is too large');
      return readFile(filePath, { workspace });
    },
    list: directory => listDirectory(directory, {workspace, includeMetadata:false, includeSymlinks:false}),
  };
  const scope = createStudioScope(userId, workspace);
  const studioPath = (filePath: string) => resolvePreviewStudioPath(filePath, workspace, userId);
  return {
    async read(filePath) {
      const fullPath = await studioPath(filePath);
      if ((await fs.stat(fullPath)).size > MAX_SOURCE_BYTES) throw new Error('HTML preview source is too large');
      return fs.readFile(fullPath);
    },
    async list(directory) {
      const fullPath = await studioPath(directory);
      const entries = await fs.readdir(fullPath, {withFileTypes:true});
      const visible = [];
      for (const entry of entries) {
        const filePath = path.posix.join(directory, entry.name);
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || !await canReadStudioMediaPath(filePath, scope)) continue;
        visible.push({path:filePath, type:entry.isDirectory() ? 'directory' as const : 'file' as const});
      }
      return visible;
    },
  };
}

function pruneTickets(now: number) {
  for (const [key, record] of tickets()) if (record.expiresAt <= now) tickets().delete(key);
}

export async function issueHtmlPreviewTicket(input: {
  session: RequestWorkspaceSession;
  workspace: WorkspaceContext;
  rootHtmlPath: string;
  kind: HtmlPreviewKind;
}) {
  if (!input.workspace.permissions.canRead || input.workspace.legacy) throw new Error('A persisted readable workspace is required for HTML preview');
  const assets = await buildHtmlPreviewAssetManifest(input.rootHtmlPath, htmlPreviewAssetReader(input.workspace, input.session.user.id, input.kind));
  const now = Date.now();
  pruneTickets(now);
  const expiresAt = Math.min(now + HTML_PREVIEW_TICKET_TTL_MS, new Date(input.session.session.expiresAt).getTime());
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Preview session expired');
  const sessionTickets = [...tickets()].filter(([, record]) => record.sessionId === input.session.session.id);
  for (const [key] of sessionTickets.slice(0, Math.max(0, sessionTickets.length - MAX_TICKETS_PER_SESSION + 1))) tickets().delete(key);
  if (tickets().size >= MAX_TICKETS) throw new Error('HTML preview is temporarily busy');
  const ticket = randomBytes(32).toString('base64url');
  tickets().set(ticketKey(ticket), {
    sessionId:input.session.session.id, userId:input.session.user.id,
    workspaceId:input.workspace.workspaceId, rootHtmlPath:input.rootHtmlPath, kind:input.kind,
    assets:new Set(assets), expiresAt,
  });
  return {ticket, expiresAt:new Date(expiresAt).toISOString()};
}

export function revokeHtmlPreviewTicket(ticket: string) { tickets().delete(ticketKey(ticket)); }

export function htmlPreviewTicketPath(ticket: string, filePath: string) {
  return `${HTML_PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(ticket)}/${normalizeHtmlPreviewPath(filePath).split('/').map(encodeURIComponent).join('/')}`;
}

/** The token carries file authority only; current account and workspace state wins. */
export async function resolveHtmlPreviewTicket(ticket: string, filePath: string) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return null;
  let normalized: string;
  try { normalized = normalizeHtmlPreviewPath(filePath); } catch { return null; }
  const record = tickets().get(ticketKey(ticket));
  if (!record || record.expiresAt <= Date.now() || !record.assets.has(normalized)) return null;
  try {
    const [current] = await db.select({session:authSession,user:authUser})
      .from(authSession).innerJoin(authUser, eq(authUser.id, authSession.userId))
      .where(and(eq(authSession.id, record.sessionId),eq(authSession.userId, record.userId),gt(authSession.expiresAt,new Date())))
      .limit(1);
    if (!current || current.user.banned) { revokeHtmlPreviewTicket(ticket);return null; }
    await assertUserSeatAccess({userId:record.userId});
    const actor=resolveWorkspaceActor(current.user);
    const workspace = await resolveExistingPostgresWorkspaceForActor(actor,record.workspaceId);
    if (!workspace?.permissions.canRead || workspace.legacy) { revokeHtmlPreviewTicket(ticket);return null; }
    const absolutePath = record.kind === 'studio' ? await resolvePreviewStudioPath(normalized,workspace,record.userId) : undefined;
    return {workspace, userId:record.userId, kind:record.kind, filePath:normalized, rootHtmlPath:record.rootHtmlPath, absolutePath};
  } catch { return null; }
}
