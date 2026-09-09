import 'server-only';

import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';

import { requireMcpCredentialScope } from '@/app/lib/mcp/scope';
import { resolveMcpStoragePath, writeMcpTextFileAtomic } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';
import { DIRECT_MCP_RESOURCE_SCOPES, resolveDirectMcpOAuthConfig } from '@/app/lib/mcp/server/config';

export type DirectMcpObservedGrant = {
  sessionId: string;
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  scopes: string[];
  observedAt: string;
};

export type DirectMcpConnectionUsage = {
  lastSuccessfulRequestAt: string | null;
  grants: DirectMcpObservedGrant[];
};

export type DirectMcpUsagePrincipal = Omit<DirectMcpObservedGrant, 'observedAt'> & {
  userId: string;
  clientId: string;
};

function usageLocation(userId: string, clientId: string) {
  const scope = requireMcpCredentialScope({ userId });
  if (!scope.userId || !clientId || clientId.length > 1024) throw new Error('Invalid MCP usage owner.');
  const { resource } = resolveDirectMcpOAuthConfig();
  const key = createHash('sha256').update(`${resource}\0${clientId}`).digest('hex');
  return { scope, resource, relativePath: `server-usage/${key}.json` };
}

function validGrant(value: unknown): value is DirectMcpObservedGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as DirectMcpObservedGrant;
  return typeof grant.sessionId === 'string' && grant.sessionId.length > 0 && grant.sessionId.length <= 1024
    && typeof grant.tokenHash === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(grant.tokenHash)
    && Number.isSafeInteger(grant.issuedAt) && grant.issuedAt > 0
    && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > grant.issuedAt
    && Array.isArray(grant.scopes) && grant.scopes.length <= DIRECT_MCP_RESOURCE_SCOPES.length
    && grant.scopes.every((scope) => (DIRECT_MCP_RESOURCE_SCOPES as readonly string[]).includes(scope))
    && typeof grant.observedAt === 'string' && Number.isFinite(Date.parse(grant.observedAt));
}

/** Historical evidence only. Every usability decision must recheck current authorization. */
export async function readDirectMcpConnectionUsage(userId: string, clientId: string): Promise<DirectMcpConnectionUsage> {
  const { scope, resource, relativePath } = usageLocation(userId, clientId);
  const empty: DirectMcpConnectionUsage = { lastSuccessfulRequestAt: null, grants: [] };
  let handle;
  try {
    handle = await fs.open(resolveMcpStoragePath(relativePath, scope), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) return empty;
    const value = JSON.parse(await handle.readFile('utf8'));
    if (value.version !== 1 || value.userId !== scope.userId || value.clientId !== clientId || value.resource !== resource
      || typeof value.lastSuccessfulRequestAt !== 'string' || !Number.isFinite(Date.parse(value.lastSuccessfulRequestAt))
      || !Array.isArray(value.grants) || value.grants.length > 10 || !value.grants.every(validGrant)) return empty;
    return { lastSuccessfulRequestAt: value.lastSuccessfulRequestAt, grants: value.grants };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return empty;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function recordDirectMcpConnectionUsage(input: DirectMcpUsagePrincipal, now = Date.now()): Promise<void> {
  const { scope, resource, relativePath } = usageLocation(input.userId, input.clientId);
  const observedAt = new Date(now).toISOString();
  const grant: DirectMcpObservedGrant = {
    sessionId: input.sessionId,
    tokenHash: input.tokenHash,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scopes: [...new Set(input.scopes)].filter((scope) => (DIRECT_MCP_RESOURCE_SCOPES as readonly string[]).includes(scope)),
    observedAt,
  };
  if (!validGrant(grant) || input.expiresAt * 1000 <= now || input.issuedAt * 1000 > now) return;
  await withMcpStorageLock(relativePath, scope, async () => {
    const previous = await readDirectMcpConnectionUsage(input.userId, input.clientId);
    const grants = [grant, ...previous.grants.filter((item) => item.tokenHash !== grant.tokenHash)]
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, 10);
    const lastSuccessfulRequestAt = previous.lastSuccessfulRequestAt && Date.parse(previous.lastSuccessfulRequestAt) > now
      ? previous.lastSuccessfulRequestAt : observedAt;
    await writeMcpTextFileAtomic(relativePath, JSON.stringify({
      version: 1, userId: scope.userId, clientId: input.clientId, resource, lastSuccessfulRequestAt, grants,
    }), scope);
  });
}
