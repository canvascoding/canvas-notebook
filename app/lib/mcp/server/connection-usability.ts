import 'server-only';

import type { DirectMcpObservedGrant } from './connection-usage';

export type DirectMcpAuthorizationStatus =
  | 'usable'
  | 'expired'
  | 'revoked'
  | 'access_denied'
  | 'authorization_required'
  | 'unknown';

export type DirectMcpSessionState = {
  sessionId: string;
  expiresAt: unknown;
  grantRevokedAt: unknown;
};

export type DirectMcpRefreshGrantState = {
  id: string;
  sessionId: string | null;
  issuedAt: unknown;
  expiresAt: unknown;
  revokedAt: unknown;
  resourceAllowed: boolean;
  scopes: readonly string[];
};

export type DirectMcpConnectionUsability = {
  authorizationStatus: DirectMcpAuthorizationStatus;
  usableGrantCount: number;
  sessionExpiresAt: string | null;
  refreshExpiresAt: string | null;
};

function timestampToMilliseconds(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampToMilliseconds(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function latestIso(values: readonly unknown[]): string | null {
  const latest = values.reduce<number | null>((current, value) => {
    const milliseconds = timestampToMilliseconds(value);
    return milliseconds === null || (current !== null && current >= milliseconds) ? current : milliseconds;
  }, null);
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * Evaluates only evidence already proven by the direct-MCP runtime. In
 * particular, a valid Canvas session is not itself evidence that this OAuth
 * client has an active grant.
 */
export function evaluateDirectMcpConnectionUsability(input: {
  effectiveScopeCount: number;
  effectiveResourceScopes: readonly string[];
  resourcePolicyActive: boolean;
  clientDisabled: boolean;
  userBanned: boolean;
  seatAllowed: boolean | null;
  workspaceStateKnown: boolean;
  usageStateKnown: boolean;
  grantStateKnown: boolean;
  allowedWorkspaceCount: number;
  usableWorkspaceCount: number;
  consentUpdatedAt: unknown;
  observedGrants: readonly DirectMcpObservedGrant[];
  revokedTokenHashes: ReadonlySet<string>;
  sessions: readonly DirectMcpSessionState[];
  refreshGrants: readonly DirectMcpRefreshGrantState[];
  now?: number;
}): DirectMcpConnectionUsability {
  const now = input.now ?? Date.now();
  const sessions = new Map(input.sessions.map((session) => [session.sessionId, session]));
  const effectiveScopes = new Set(input.effectiveResourceScopes);
  const consentUpdatedAt = timestampToMilliseconds(input.consentUpdatedAt);
  const usable = new Set<string>();
  let sawExpired = false;
  let sawRevoked = false;
  let sawAuthorizationRequired = false;
  let sawUnknown = false;
  const relevantSessionExpiries: unknown[] = [];

  for (const grant of input.observedGrants) {
    const session = sessions.get(grant.sessionId);
    const sessionExpiresAt = timestampToMilliseconds(session?.expiresAt);
    const revokedAt = timestampToMilliseconds(session?.grantRevokedAt);
    if (!session || !Number.isFinite(grant.issuedAt) || !Number.isFinite(grant.expiresAt) || consentUpdatedAt === null || sessionExpiresAt === null) {
      sawUnknown = true;
      continue;
    }
    relevantSessionExpiries.push(session.expiresAt);
    if (input.revokedTokenHashes.has(grant.tokenHash)) {
      sawRevoked = true;
      continue;
    }
    if (revokedAt !== null && grant.issuedAt * 1000 <= revokedAt) {
      sawRevoked = true;
      continue;
    }
    if (grant.issuedAt * 1000 < consentUpdatedAt) {
      sawRevoked = true;
      continue;
    }
    if (grant.expiresAt * 1000 <= now || sessionExpiresAt <= now) {
      sawExpired = true;
      continue;
    }
    if (!Array.isArray(grant.scopes)) {
      sawUnknown = true;
      continue;
    }
    if (!grant.scopes.some((scope) => effectiveScopes.has(scope))) {
      sawAuthorizationRequired = true;
      continue;
    }
    usable.add(`access:${grant.sessionId}:${grant.tokenHash}`);
  }

  const refreshExpiries: unknown[] = [];
  for (const grant of input.refreshGrants) {
    const issuedAt = timestampToMilliseconds(grant.issuedAt);
    const expiresAt = timestampToMilliseconds(grant.expiresAt);
    const revokedAt = timestampToMilliseconds(grant.revokedAt);
    const session = grant.sessionId ? sessions.get(grant.sessionId) : undefined;
    const sessionExpiresAt = timestampToMilliseconds(session?.expiresAt);
    const sessionGrantRevokedAt = timestampToMilliseconds(session?.grantRevokedAt);
    if (expiresAt !== null) refreshExpiries.push(grant.expiresAt);
    if (!grant.sessionId || !session || issuedAt === null || expiresAt === null || sessionExpiresAt === null || consentUpdatedAt === null) {
      sawUnknown = true;
      continue;
    }
    relevantSessionExpiries.push(session.expiresAt);
    if (!grant.resourceAllowed || !grant.scopes.some((scope) => effectiveScopes.has(scope))) {
      sawAuthorizationRequired = true;
      continue;
    }
    if (revokedAt !== null || (sessionGrantRevokedAt !== null && issuedAt <= sessionGrantRevokedAt)
      || issuedAt < consentUpdatedAt) {
      sawRevoked = true;
      continue;
    }
    if (expiresAt <= now || sessionExpiresAt <= now) {
      sawExpired = true;
      continue;
    }
    usable.add(`refresh:${grant.id}`);
  }

  const baseline: Omit<DirectMcpConnectionUsability, 'authorizationStatus' | 'usableGrantCount'> = {
    sessionExpiresAt: latestIso(relevantSessionExpiries),
    refreshExpiresAt: latestIso(refreshExpiries),
  };
  if (!input.resourcePolicyActive || input.clientDisabled || input.userBanned || input.seatAllowed === false) {
    return { ...baseline, authorizationStatus: 'access_denied', usableGrantCount: 0 };
  }
  if (input.seatAllowed === null || !input.workspaceStateKnown || !input.grantStateKnown) {
    return { ...baseline, authorizationStatus: 'unknown', usableGrantCount: 0 };
  }
  if (input.allowedWorkspaceCount === 0 || input.usableWorkspaceCount === 0) {
    return { ...baseline, authorizationStatus: 'access_denied', usableGrantCount: 0 };
  }
  if (input.effectiveScopeCount === 0) {
    return { ...baseline, authorizationStatus: 'authorization_required', usableGrantCount: 0 };
  }
  if (usable.size) return { ...baseline, authorizationStatus: 'usable', usableGrantCount: usable.size };
  if (!input.usageStateKnown || sawUnknown) {
    return { ...baseline, authorizationStatus: 'unknown', usableGrantCount: 0 };
  }
  if (sawRevoked) return { ...baseline, authorizationStatus: 'revoked', usableGrantCount: 0 };
  if (sawExpired) return { ...baseline, authorizationStatus: 'expired', usableGrantCount: 0 };
  if (sawAuthorizationRequired) return { ...baseline, authorizationStatus: 'authorization_required', usableGrantCount: 0 };
  return { ...baseline, authorizationStatus: 'authorization_required', usableGrantCount: 0 };
}
