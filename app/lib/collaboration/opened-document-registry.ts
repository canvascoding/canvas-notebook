import type { CurrentFile } from '../files/types';
import type { CollaborationSessionResponse } from './types';

export type OpenedDocumentAuthScope = Readonly<{ userId: string; sessionId: string; epoch: number }>;
type OpenedDocument = {
  scope: OpenedDocumentAuthScope;
  workspaceId: string;
  path: string;
  file: CurrentFile;
  session: CollaborationSessionResponse;
  stateProof: string;
  /** Clocks and DeleteSet only, never document text. */
  snapshot: Uint8Array;
};
let authScope: OpenedDocumentAuthScope | null = null;
let epoch = 0;
const opened = new Map<string, OpenedDocument>();
const invalidationListeners = new Set<() => void>();
const localSessions = new WeakMap<CollaborationSessionResponse, OpenedDocument>();
const keyFor = (workspaceId: string, path: string) => JSON.stringify([workspaceId, path]);
let authorizationRevision = 0;
const revokedAt = new Map<string, number>();
const authorizations = new WeakMap<CollaborationSessionResponse, {
  scope: OpenedDocumentAuthScope; workspaceId: string; path: string; revision: number;
}>();
const documentKeyFor = (workspaceId: string, documentId: string) => JSON.stringify(['document', workspaceId, documentId]);
export function openedDocumentRequestRevision(): number { return authorizationRevision; }

/** Auth observations come from the existing BetterAuth session atom, never storage or a document ticket. */
export function observeOpenedDocumentAuth(value: unknown): void {
  const data = value as { data?: { user?: { id?: unknown }; session?: { id?: unknown } }; error?: { status?: unknown } } | null;
  const userId = data?.data?.user?.id;
  const sessionId = data?.data?.session?.id;
  const denied = data?.error?.status === 401 || data?.error?.status === 403;
  const next = !denied && typeof userId === 'string' && typeof sessionId === 'string' ? { userId, sessionId } : null;
  if (authScope?.userId === next?.userId && authScope?.sessionId === next?.sessionId) return;
  const previous = authScope;
  opened.clear();
  revokedAt.clear();
  authScope = next ? { ...next, epoch: ++epoch } : null;
  if (!next) epoch++;
  // Initial auth hydration is not revocation. Every subsequent partition change is.
  if (previous) for (const listener of invalidationListeners) listener();
}

/** Sign-out/session mutation invalidates immediately, before any asynchronous auth refetch. */
export function invalidateOpenedDocumentAuth(): void {
  opened.clear();
  if (authScope) authScope = { ...authScope, epoch: ++epoch };
  else epoch++;
  for (const listener of invalidationListeners) listener();
}

export function openedDocumentAuthScope(): OpenedDocumentAuthScope | null { return authScope; }
export function isOpenedDocumentAuthCurrent(scope: OpenedDocumentAuthScope | null): boolean {
  return scope !== null && scope === authScope;
}
export function subscribeOpenedDocumentAuthInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

export function sameOpenedDocumentSession(left: CollaborationSessionResponse, right: CollaborationSessionResponse): boolean {
  return left.user.id === right.user.id && (left.guestAccess?.invitationId ?? null) === (right.guestAccess?.invitationId ?? null)
    && (left.guestAccess?.workspaceId ?? null) === (right.guestAccess?.workspaceId ?? null)
    && left.documentId === right.documentId && left.documentName === right.documentName
    && left.lifecycleGeneration === right.lifecycleGeneration && left.schemaVersion === right.schemaVersion
    && left.richTextSchemaVersion === right.richTextSchemaVersion && left.blockTreeFormatVersion === right.blockTreeFormatVersion
    && left.representation === right.representation;
}

/** Only the mounted, authenticated, hydrated live document may create this receipt. No Markdown content is retained. */
export function rememberOpenedLiveDocument(input: {
  scope: OpenedDocumentAuthScope | null; workspaceId: string; path: string; file: CurrentFile;
  session: CollaborationSessionResponse; stateProof: string; snapshot: Uint8Array;
}): void {
  const authorization = authorizations.get(input.session);
  if (!isOpenedDocumentAuthCurrent(input.scope) || input.session.guestAccess || input.session.user.id !== input.scope!.userId
    || input.file.unavailable || !input.file.collaboration?.crdtCapable
    || input.file.path !== input.path || input.file.collaboration.document?.id !== input.session.documentId
    || input.session.provider !== 'yjs' || !authorization || authorization.scope !== input.scope
    || authorization.workspaceId !== input.workspaceId || authorization.path !== input.path
    || authorization.revision < (revokedAt.get(keyFor(input.workspaceId, input.path)) ?? 0)
    || authorization.revision < (revokedAt.get(documentKeyFor(input.workspaceId, input.session.documentId)) ?? 0)) return;
  const key = keyFor(input.workspaceId, input.path);
  opened.delete(key);
  const session = { ...input.session };
  authorizations.set(session, authorization);
  opened.set(key, { ...input, snapshot: input.snapshot.slice(), scope: input.scope!, file: { ...input.file, content: '' }, session });
  if (opened.size > 32) opened.delete(opened.keys().next().value!);
}

export function findOpenedLiveDocument(workspaceId: string, path: string, documentId: string | null | undefined,
  scope = authScope): OpenedDocument | null {
  if (!documentId || !isOpenedDocumentAuthCurrent(scope)) return null;
  const entry = opened.get(keyFor(workspaceId, path));
  return entry && entry.scope === scope && entry.session.documentId === documentId ? entry : null;
}

export function invalidateOpenedLiveDocument(workspaceId: string, input: { path?: string; documentId?: string }, scope = authScope): void {
  if (!isOpenedDocumentAuthCurrent(scope)) return;
  const revision = ++authorizationRevision;
  if (input.path) revokedAt.set(keyFor(workspaceId, input.path), revision);
  if (input.documentId) revokedAt.set(documentKeyFor(workspaceId, input.documentId), revision);
  for (const [key, entry] of opened) {
    if (entry.scope === scope && entry.workspaceId === workspaceId
      && (input.path === entry.path || input.documentId === entry.session.documentId)) {
      revokedAt.set(key, revision);
      revokedAt.set(documentKeyFor(workspaceId, entry.session.documentId), revision);
      opened.delete(key);
    }
  }
}

export function validateOpenedLiveDocumentSession(workspaceId: string, path: string, session: CollaborationSessionResponse,
  scope = authScope, requestRevision = authorizationRevision): boolean {
  if (!isOpenedDocumentAuthCurrent(scope)) return false;
  if (requestRevision < (revokedAt.get(keyFor(workspaceId, path)) ?? 0)
    || requestRevision < (revokedAt.get(documentKeyFor(workspaceId, session.documentId)) ?? 0)) return false;
  const entry = opened.get(keyFor(workspaceId, path));
  if (entry && (!sameOpenedDocumentSession(entry.session, session) || entry.session.permission !== session.permission)) {
    invalidateOpenedLiveDocument(workspaceId, { path, documentId: entry.session.documentId }, scope);
  }
  authorizations.set(session, { scope: scope!, workspaceId, path, revision: authorizationRevision });
  return true;
}

/** An authoritative move/restore invalidates the old receipt before another request can fail offline. */
export function validateOpenedLiveDocumentLocation(workspaceId: string, documentId: string,
  location: { path: string; lifecycleGeneration: number | null; representation: string | null }, scope = authScope): void {
  if (!isOpenedDocumentAuthCurrent(scope)) return;
  for (const entry of opened.values()) {
    if (entry.workspaceId === workspaceId && entry.session.documentId === documentId
      && (entry.path !== location.path || entry.session.lifecycleGeneration !== location.lifecycleGeneration
        || entry.session.representation !== location.representation)) {
      invalidateOpenedLiveDocument(workspaceId, { documentId, path: entry.path }, scope);
    }
  }
}

export function localOpenedDocumentSession(entry: OpenedDocument): CollaborationSessionResponse {
  const session = { ...entry.session };
  localSessions.set(session, entry);
  const authorization = authorizations.get(entry.session);
  if (authorization) authorizations.set(session, authorization);
  return session;
}
export function localOpenedDocumentReceipt(session: CollaborationSessionResponse): OpenedDocument | null {
  const entry = localSessions.get(session);
  return entry && findOpenedLiveDocument(entry.workspaceId, entry.path, entry.session.documentId, entry.scope) === entry ? entry : null;
}
export function isLocalOpenedDocumentSession(session: CollaborationSessionResponse): boolean { return localSessions.has(session); }

export class LiveDocumentNetworkError extends Error {
  constructor() { super('The document connection is unavailable.'); this.name = 'LiveDocumentNetworkError'; }
}
/** Only a rejection of the actual fetch is tagged. HTTP, JSON, schema and aborted requests never qualify. */
export async function fetchLiveDocument(input: string, init: RequestInit): Promise<Response> {
  try { return await fetch(input, init); }
  catch (error) {
    if (!init.signal?.aborted && error instanceof TypeError) throw new LiveDocumentNetworkError();
    throw error;
  }
}
