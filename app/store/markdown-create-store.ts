import { create } from 'zustand';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation,
  type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { validManualMarkdownCreateCoordinates, type ManualMarkdownCreateAttempt,
  type ManualMarkdownCreateCoordinates } from '@/app/lib/files/markdown-create-result';

export type MarkdownCreateEntry = ManualMarkdownCreateAttempt & { scope: OpenedDocumentAuthScope; busy: boolean };
export const useMarkdownCreateStore = create<{ attempts: Record<string, MarkdownCreateEntry> }>(() => ({ attempts: {} }));
const storagePrefix = 'canvas-markdown-create-resumes:v1:';
const maxAttempts = 16;
const maxStorageLength = 128 * 1024;
let hydratedScope: OpenedDocumentAuthScope | null = null;
let oversizedScope: OpenedDocumentAuthScope | null = null;
const keyFor = (item: ManualMarkdownCreateCoordinates) => JSON.stringify([item.workspaceId, item.requestId]);
const storageKey = (userId: string) => storagePrefix + encodeURIComponent(userId);

function publicAttempt(entry: ManualMarkdownCreateAttempt): ManualMarkdownCreateAttempt {
  return { requestId: entry.requestId, workspaceId: entry.workspaceId, targetPath: entry.targetPath, status: entry.status };
}

function serializeAttempts(scope: OpenedDocumentAuthScope, attempts: readonly ManualMarkdownCreateAttempt[]): string {
  return JSON.stringify({ version: 1, accountId: scope.userId, attempts: attempts.map(publicAttempt) });
}

function validAttempt(value: unknown): value is ManualMarkdownCreateAttempt {
  return validManualMarkdownCreateCoordinates(value)
    && Object.keys(value).sort().join(',') === 'requestId,status,targetPath,workspaceId'
    && ['unconfirmed', 'projection_pending', 'recovery_required', 'unavailable'].includes((value as ManualMarkdownCreateAttempt).status);
}

function persistAttempts(): void {
  const scope = openedDocumentAuthScope();
  if (typeof window === 'undefined' || !scope || scope !== hydratedScope || scope === oversizedScope) return;
  const attempts = Object.values(useMarkdownCreateStore.getState().attempts)
    .filter(entry => entry.scope === scope);
  const raw = serializeAttempts(scope, attempts);
  if (raw.length > maxStorageLength) return;
  try {
    window.localStorage.setItem(storageKey(scope.userId), raw);
  } catch { /* The current page retains its attempts when browser storage is unavailable. */ }
}

/** Restore only bounded public lookup tuples. Hydration never submits a request. */
export function hydrateMarkdownCreateAttempts(scope: OpenedDocumentAuthScope): void {
  if (typeof window === 'undefined' || openedDocumentAuthScope() !== scope) return;
  hydratedScope = scope;
  try {
    const raw = window.localStorage.getItem(storageKey(scope.userId));
    if (raw && raw.length > maxStorageLength) { oversizedScope = scope; return; }
    oversizedScope = null;
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || Object.keys(saved).sort().join(',') !== 'accountId,attempts,version'
      || saved.version !== 1 || saved.accountId !== scope.userId || !Array.isArray(saved.attempts)
      || saved.attempts.length > maxAttempts || !saved.attempts.every(validAttempt)
      || openedDocumentAuthScope() !== scope) return;
    const values = saved.attempts as ManualMarkdownCreateAttempt[];
    if (new Set(values.map(keyFor)).size !== values.length
      || new Set(values.map(item => JSON.stringify([item.workspaceId, item.targetPath]))).size !== values.length) return;
    useMarkdownCreateStore.setState(({ attempts }) => {
      const next = { ...attempts };
      for (const attempt of values) {
        const key = keyFor(attempt);
        if (!next[key] && Object.values(next).filter(entry => entry.scope === scope).length < maxAttempts) {
          next[key] = { ...attempt, scope, busy: false };
        }
      }
      return { attempts: next };
    });
  } catch { /* Untrusted or unavailable storage cannot authorize a creation. */ }
}

export class MarkdownCreateAttemptError extends Error {
  constructor(readonly code: 'MARKDOWN_CREATE_BUSY' | 'MARKDOWN_CREATE_LIMIT' | 'MARKDOWN_CREATE_SCOPE_CHANGED') {
    super(code === 'MARKDOWN_CREATE_LIMIT' ? 'Check the pending document creations before creating another document.'
      : code === 'MARKDOWN_CREATE_BUSY' ? 'This document creation is already being checked.' : 'The document creation session changed.');
    this.name = 'MarkdownCreateAttemptError';
  }
}

/** Reserve and persist a fixed attempt before dispatch; only an explicit user action calls this. */
export function reserveMarkdownCreateAttempt(input: {
  workspaceId: string; targetPath: string; requestId?: string;
}): MarkdownCreateEntry {
  const scope = openedDocumentAuthScope();
  if (!scope) throw new MarkdownCreateAttemptError('MARKDOWN_CREATE_SCOPE_CHANGED');
  hydrateMarkdownCreateAttempts(scope);
  if (oversizedScope === scope) throw new MarkdownCreateAttemptError('MARKDOWN_CREATE_LIMIT');
  const attempts = useMarkdownCreateStore.getState().attempts;
  const sameTarget = Object.values(attempts).find(entry => entry.scope === scope
    && entry.workspaceId === input.workspaceId && entry.targetPath === input.targetPath);
  const found = input.requestId ? attempts[keyFor({ ...input, requestId: input.requestId })] : sameTarget;
  if ((found && (found.scope !== scope || found.targetPath !== input.targetPath))
    || (sameTarget && input.requestId && sameTarget.requestId !== input.requestId)) {
    throw new MarkdownCreateAttemptError('MARKDOWN_CREATE_SCOPE_CHANGED');
  }
  if (found?.busy) throw new MarkdownCreateAttemptError('MARKDOWN_CREATE_BUSY');
  if (!found && Object.values(attempts).filter(entry => entry.scope === scope).length >= maxAttempts) {
    throw new MarkdownCreateAttemptError('MARKDOWN_CREATE_LIMIT');
  }
  const requestId = found?.requestId ?? input.requestId ?? globalThis.crypto?.randomUUID();
  const attempt = { workspaceId: input.workspaceId, targetPath: input.targetPath, requestId };
  if (!validManualMarkdownCreateCoordinates(attempt)) throw new Error('The document name or creation request is invalid.');
  const entry: MarkdownCreateEntry = { ...attempt, status: found?.status ?? 'unconfirmed', scope, busy: true };
  const next = { ...attempts, [keyFor(entry)]: entry };
  if (serializeAttempts(scope, Object.values(next).filter(item => item.scope === scope)).length > maxStorageLength) {
    throw new MarkdownCreateAttemptError('MARKDOWN_CREATE_LIMIT');
  }
  useMarkdownCreateStore.setState({ attempts: next });
  return entry;
}

/** Settling cannot replace coordinates or revive a record after an auth invalidation. */
export function settleMarkdownCreateAttempt(entry: MarkdownCreateEntry, status: ManualMarkdownCreateAttempt['status'] | 'completed' | 'rejected'): void {
  if (openedDocumentAuthScope() !== entry.scope) return;
  useMarkdownCreateStore.setState(({ attempts }) => {
    const key = keyFor(entry), existing = attempts[key];
    if (!existing || existing.scope !== entry.scope || existing.targetPath !== entry.targetPath) return { attempts };
    const next = { ...attempts };
    if (status === 'completed' || status === 'rejected') delete next[key];
    else next[key] = { ...existing, busy: false, status };
    return { attempts: next };
  });
}

/** Explicitly hide one local lookup. The server operation and document are untouched. */
export function hideMarkdownCreateAttempt(attempt: ManualMarkdownCreateCoordinates): void {
  const entry = useMarkdownCreateStore.getState().attempts[keyFor(attempt)];
  if (!entry || entry.busy || entry.targetPath !== attempt.targetPath || entry.scope !== openedDocumentAuthScope()) return;
  settleMarkdownCreateAttempt(entry, 'rejected');
}

useMarkdownCreateStore.subscribe(persistAttempts);
subscribeOpenedDocumentAuthInvalidation(() => {
  const scope = hydratedScope;
  hydratedScope = null;
  oversizedScope = null;
  if (scope) {
    try { if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(scope.userId)); } catch { /* Account scoped only. */ }
  }
  useMarkdownCreateStore.setState({ attempts: {} });
});
