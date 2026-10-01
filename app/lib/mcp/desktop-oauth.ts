import 'server-only';

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { McpAccessError } from './access';
import { readMcpCredentialJson, writeMcpCredentialJson } from './credential-storage';
import {
  assertMcpDesktopOAuthSnapshot, collectMcpDesktopOAuthState, completeStoredMcpOAuth,
  discardMcpDesktopOAuthState, getMcpOAuthStatus, type OAuthStateRecord,
} from './oauth';
import { MCP_SYSTEM_SCOPE, type McpScope } from './scope';
import { readMcpTextFileIfExists, removeMcpStoragePath, resolveMcpStoragePath } from './storage';
import { withMcpStorageLock } from './storage-lock';

const DIRECTORY = 'desktop-oauth-transactions';
const RETAIN_TERMINAL_MS = 60 * 60_000;
const MAX_PENDING = 8;
let lastCleanupAt = 0;

export type McpDesktopOAuthStatus = 'waiting' | 'callback_received' | 'completed' | 'cancelled' | 'expired' | 'failed';
type Snapshot = Pick<OAuthStateRecord, 'connectionId' | 'organizationId' | 'authVersion' | 'configHash' | 'lifecycleGeneration' | 'serverUrl'>;
type DesktopTransaction = {
  version: 1;
  state: string;
  ownerUserId: string;
  organizationId: string | null;
  connectionId: string;
  serverName: string;
  authorizationUrl: string;
  issuer: string;
  requiresIssuer: boolean;
  snapshot: Snapshot;
  createdAt: string;
  expiresAt: string;
  status: McpDesktopOAuthStatus;
  error?: string;
  code?: string;
  response?: { code: string; stored: OAuthStateRecord };
};

export type McpDesktopOAuthSummary = {
  status: McpDesktopOAuthStatus;
  expiresAt: string;
  serverName: string;
  connectionId: string;
  authorizationUrl?: string;
  error?: string;
  code?: string;
};

export class McpDesktopOAuthError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'desktop_oauth_invalid_state') {
    super(message);
    this.name = 'McpDesktopOAuthError';
  }
}

export function isMcpDesktopOAuthState(state: unknown): state is string {
  return typeof state === 'string' && /^desktop_[A-Za-z0-9_-]{32}$/u.test(state);
}

function transactionPath(state: string): string {
  if (!isMcpDesktopOAuthState(state)) throw new McpDesktopOAuthError('Invalid desktop sign-in state.', 400);
  return path.posix.join(DIRECTORY, `${crypto.createHash('sha256').update(state).digest('hex')}.json`);
}

function ownerScope(transaction: DesktopTransaction): McpScope {
  return { userId: transaction.ownerUserId, organizationId: transaction.organizationId };
}

async function readTransaction(state: string): Promise<DesktopTransaction> {
  const record = await readMcpCredentialJson<DesktopTransaction>(transactionPath(state), MCP_SYSTEM_SCOPE);
  if (!record || record.version !== 1 || record.state !== state || !record.ownerUserId
    || record.connectionId !== record.snapshot?.connectionId || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new McpDesktopOAuthError('This desktop sign-in has expired or is no longer available.');
  }
  return record;
}

async function saveTransaction(transaction: DesktopTransaction): Promise<void> {
  await writeMcpCredentialJson(transactionPath(transaction.state), transaction, MCP_SYSTEM_SCOPE);
}

function summary(transaction: DesktopTransaction): McpDesktopOAuthSummary {
  return {
    status: transaction.status, expiresAt: transaction.expiresAt,
    serverName: transaction.serverName, connectionId: transaction.connectionId,
    ...(transaction.status === 'waiting' ? { authorizationUrl: transaction.authorizationUrl } : {}),
    ...(transaction.error ? { error: transaction.error, code: transaction.code } : {}),
  };
}

async function finishTransaction(transaction: DesktopTransaction, status: McpDesktopOAuthStatus, code?: string, error?: string): Promise<void> {
  transaction.status = status;
  transaction.code = code;
  transaction.error = error;
  delete transaction.response;
  await discardMcpDesktopOAuthState(transaction.state, ownerScope(transaction));
  await saveTransaction(transaction);
}

async function expireTransaction(transaction: DesktopTransaction): Promise<boolean> {
  if (!['waiting', 'callback_received'].includes(transaction.status) || Date.parse(transaction.expiresAt) > Date.now()) return false;
  await finishTransaction(transaction, 'expired', 'desktop_oauth_expired', 'This sign-in expired. Start a new connection sign-in.');
  return true;
}

async function verifyActiveTransaction(transaction: DesktopTransaction): Promise<void> {
  await assertMcpDesktopOAuthSnapshot(transaction.snapshot, ownerScope(transaction));
}

async function withTransaction<T>(state: string, task: (transaction: DesktopTransaction) => Promise<T>): Promise<T> {
  const relativePath = transactionPath(state);
  return withMcpStorageLock(`desktop-transaction-${relativePath}`, MCP_SYSTEM_SCOPE, async () => task(await readTransaction(state)));
}

async function cleanupOldTransactions(): Promise<void> {
  if (Date.now() - lastCleanupAt < 60_000) return;
  lastCleanupAt = Date.now();
  let directory;
  try { directory = await fs.opendir(resolveMcpStoragePath(DIRECTORY, MCP_SYSTEM_SCOPE)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let visited = 0;
  for await (const entry of directory) {
    if (++visited > 200) break;
    const file = entry.name;
    if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
    const relativePath = path.posix.join(DIRECTORY, file);
    const envelope = await readMcpTextFileIfExists(relativePath, MCP_SYSTEM_SCOPE);
    if (!envelope.content) continue;
    const record = await readMcpCredentialJson<DesktopTransaction>(relativePath, MCP_SYSTEM_SCOPE).catch(() => null);
    if (!record || Date.parse(record.expiresAt) + RETAIN_TERMINAL_MS > Date.now()) continue;
    await withTransaction(record.state, async current => {
      if (Date.parse(current.expiresAt) + RETAIN_TERMINAL_MS > Date.now()) return;
      await discardMcpDesktopOAuthState(current.state, ownerScope(current));
      await removeMcpStoragePath(relativePath, MCP_SYSTEM_SCOPE);
    }).catch(() => undefined);
  }
}

export async function createMcpDesktopOAuthTransaction(stored: OAuthStateRecord, authorizationUrl: string): Promise<void> {
  if (!stored.desktop || !stored.ownerUserId || !isMcpDesktopOAuthState(stored.state)) throw new McpDesktopOAuthError('Desktop sign-in requires its original owner.', 400);
  const ownerUserId = stored.ownerUserId;
  await cleanupOldTransactions();
  // The per-owner creation lock bounds outstanding locators across processes.
  await withMcpStorageLock(`desktop-owner-${crypto.createHash('sha256').update(stored.ownerUserId).digest('hex')}`, MCP_SYSTEM_SCOPE, async () => {
    const indexPath = `desktop-oauth-owner-index/${crypto.createHash('sha256').update(ownerUserId).digest('hex')}.json`;
    const index = await readMcpCredentialJson<{ states: Array<{ state: string; expiresAt: string }> }>(indexPath, MCP_SYSTEM_SCOPE);
    const pending: Array<{ state: string; expiresAt: string }> = [];
    for (const item of index?.states || []) {
      if (Date.parse(item.expiresAt) <= Date.now()) continue;
      const record = await readTransaction(item.state).catch(() => null);
      if (record && record.ownerUserId === ownerUserId && ['waiting', 'callback_received'].includes(record.status)) pending.push(item);
    }
    if (pending.length >= MAX_PENDING) throw new McpDesktopOAuthError('Too many desktop sign-ins are waiting. Finish or cancel an existing sign-in.', 429, 'desktop_oauth_busy');
    const snapshot: Snapshot = {
      connectionId: stored.connectionId, organizationId: stored.organizationId || null,
      authVersion: stored.authVersion, configHash: stored.configHash,
      lifecycleGeneration: stored.lifecycleGeneration, serverUrl: stored.serverUrl,
    };
    const transaction: DesktopTransaction = {
      version: 1, state: stored.state, ownerUserId,
      organizationId: stored.organizationId || null, connectionId: stored.connectionId,
      serverName: stored.serverName, authorizationUrl, issuer: stored.issuer,
      requiresIssuer: stored.authorizationResponseIssParameterSupported,
      snapshot, createdAt: stored.createdAt, expiresAt: stored.expiresAt, status: 'waiting',
    };
    await saveTransaction(transaction);
    await writeMcpCredentialJson(indexPath, { connectionId: 'desktop-index', organizationId: null, states: [...pending, { state: stored.state, expiresAt: stored.expiresAt }] }, MCP_SYSTEM_SCOPE);
  });
}

/** The public callback only collects a one-time code; it never exchanges tokens. */
export async function receiveMcpDesktopOAuthCallback(input: { state: string; code?: string | null; error?: string | null; issuer?: string | null }): Promise<McpDesktopOAuthSummary> {
  return withTransaction(input.state, async transaction => {
    if (await expireTransaction(transaction)) throw new McpDesktopOAuthError('This desktop sign-in expired.', 409, 'desktop_oauth_expired');
    if (transaction.status !== 'waiting') throw new McpDesktopOAuthError('This desktop sign-in response was already used.');
    try {
      if (transaction.requiresIssuer && !input.issuer || input.issuer && input.issuer !== transaction.issuer) throw new McpDesktopOAuthError('The sign-in response issuer is invalid.', 400);
      if ((!input.code || input.code.length > 8192) && !input.error || input.code && input.error) throw new McpDesktopOAuthError('The sign-in response is invalid.', 400);
      await verifyActiveTransaction(transaction);
      const stored = await collectMcpDesktopOAuthState(transaction.state, input.issuer, ownerScope(transaction));
      if (stored.connectionId !== transaction.connectionId || stored.ownerUserId !== transaction.ownerUserId
        || stored.issuer !== transaction.issuer || JSON.stringify({ ...transaction.snapshot }) !== JSON.stringify({
          connectionId: stored.connectionId, organizationId: stored.organizationId || null,
          authVersion: stored.authVersion, configHash: stored.configHash, lifecycleGeneration: stored.lifecycleGeneration, serverUrl: stored.serverUrl,
        })) throw new McpDesktopOAuthError('The sign-in transaction binding changed.', 400);
      if (input.error) {
        const cancelled = input.error === 'access_denied';
        await finishTransaction(transaction, cancelled ? 'cancelled' : 'failed', cancelled ? 'desktop_oauth_cancelled' : 'desktop_oauth_provider_error', cancelled ? 'Sign-in was cancelled.' : 'The provider could not complete sign-in.');
      } else {
        transaction.response = { code: input.code!, stored };
        transaction.status = 'callback_received';
        await saveTransaction(transaction);
      }
      return summary(transaction);
    } catch (error) {
      await finishTransaction(transaction, 'failed', (error as { code?: string }).code || 'desktop_oauth_failed', 'This sign-in could not be completed. Start sign-in again.');
      throw error;
    }
  });
}

function assertOwner(transaction: DesktopTransaction, userId: string): void {
  if (transaction.ownerUserId !== userId) throw new McpAccessError('This sign-in belongs to another account.', 403, 'MCP_ACCESS_DENIED');
}

export async function getMcpDesktopOAuthStatus(state: string, userId: string): Promise<McpDesktopOAuthSummary> {
  return withTransaction(state, async transaction => {
    assertOwner(transaction, userId);
    if (await expireTransaction(transaction)) return summary(transaction);
    if (['waiting', 'callback_received'].includes(transaction.status)) {
      try { await verifyActiveTransaction(transaction); } catch (error) {
        await finishTransaction(transaction, 'failed', (error as { code?: string }).code || 'reauth_required', 'This connection changed or access was revoked. Start sign-in again.');
      }
    }
    return summary(transaction);
  });
}

export async function cancelMcpDesktopOAuth(state: string, userId: string): Promise<McpDesktopOAuthSummary> {
  return withTransaction(state, async transaction => {
    assertOwner(transaction, userId);
    if (await expireTransaction(transaction)) return summary(transaction);
    if (['waiting', 'callback_received'].includes(transaction.status)) await finishTransaction(transaction, 'cancelled', 'desktop_oauth_cancelled', 'Sign-in was cancelled.');
    return summary(transaction);
  });
}

export async function finalizeMcpDesktopOAuth(state: string, userId: string): Promise<McpDesktopOAuthSummary> {
  return withTransaction(state, async transaction => {
    assertOwner(transaction, userId);
    if (await expireTransaction(transaction)) return summary(transaction);
    if (transaction.status === 'completed') return summary(transaction);
    if (transaction.status !== 'callback_received' || !transaction.response) return summary(transaction);
    try {
      await verifyActiveTransaction(transaction);
      // A process can stop after the fenced token commit but before this locator
      // is completed. Recover only the exact, still-bound authorization state.
      const oauth = await getMcpOAuthStatus(transaction.connectionId, null, ownerScope(transaction));
      if (!oauth.authorized || oauth.lastCompletedState !== transaction.state) {
        await completeStoredMcpOAuth(transaction.response.code, transaction.state, transaction.response.stored, ownerScope(transaction));
      }
      await finishTransaction(transaction, 'completed');
      const { closeMcpServer } = await import('./manager');
      await closeMcpServer(transaction.connectionId, ownerScope(transaction)).catch(() => undefined);
      return summary(transaction);
    } catch (error) {
      await finishTransaction(transaction, 'failed', (error as { code?: string }).code || 'desktop_oauth_failed', 'Sign-in could not be saved. Start sign-in again.');
      throw error;
    }
  });
}
