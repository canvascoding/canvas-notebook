import assert from 'node:assert/strict';

import { evaluateDirectMcpConnectionUsability } from '../app/lib/mcp/server/connection-usability';

const now = 1_750_000_000_000;
const session = { sessionId: 'session-a', expiresAt: now + 60_000, grantRevokedAt: null };
const access = { sessionId: 'session-a', tokenHash: 'hash-a', issuedAt: Math.floor((now - 1_000) / 1000), expiresAt: Math.floor((now + 30_000) / 1000), observedAt: new Date(now).toISOString(), scopes: ['workspace:list'] };

function evaluate(overrides: Partial<Parameters<typeof evaluateDirectMcpConnectionUsability>[0]> = {}) {
  return evaluateDirectMcpConnectionUsability({
    effectiveScopeCount: 1,
    effectiveResourceScopes: ['workspace:list'],
    resourcePolicyActive: true,
    clientDisabled: false,
    userBanned: false,
    seatAllowed: true,
    workspaceStateKnown: true,
    usageStateKnown: true,
    grantStateKnown: true,
    allowedWorkspaceCount: 1,
    usableWorkspaceCount: 1,
    consentUpdatedAt: now - 2_000,
    observedGrants: [access],
    revokedTokenHashes: new Set(),
    sessions: [session],
    refreshGrants: [],
    now,
    ...overrides,
  });
}

function main(): void {
  const usable = evaluate();
  assert.equal(usable.authorizationStatus, 'usable');
  assert.equal(usable.usableGrantCount, 1);
  assert.equal(usable.sessionExpiresAt, new Date(now + 60_000).toISOString());
  assert.equal(usable.refreshExpiresAt, null);

  assert.equal(evaluate({ observedGrants: [] }).authorizationStatus, 'authorization_required', 'an active Canvas session alone is not a client grant');
  assert.equal(evaluate({ observedGrants: [{ ...access, expiresAt: Math.floor((now - 1) / 1000) }] }).authorizationStatus, 'expired');
  assert.equal(evaluate({ sessions: [{ ...session, grantRevokedAt: now - 500 }] }).authorizationStatus, 'revoked');
  assert.equal(evaluate({ revokedTokenHashes: new Set([access.tokenHash]) }).authorizationStatus, 'revoked');
  assert.equal(evaluate({ userBanned: true }).authorizationStatus, 'access_denied');
  assert.equal(evaluate({ seatAllowed: false }).authorizationStatus, 'access_denied');
  assert.equal(evaluate({ usableWorkspaceCount: 0 }).authorizationStatus, 'access_denied');
  assert.equal(evaluate({ observedGrants: [{ ...access, sessionId: 'missing-session' }] }).authorizationStatus, 'unknown');
  assert.equal(evaluate({ observedGrants: [], usageStateKnown: false }).authorizationStatus, 'unknown');
  assert.equal(evaluate({ seatAllowed: null }).authorizationStatus, 'unknown', 'an unavailable seat check cannot be reported usable');
  assert.equal(evaluate({ workspaceStateKnown: false, usableWorkspaceCount: 0 }).authorizationStatus, 'unknown');
  const refreshed = evaluate({
    observedGrants: [],
    refreshGrants: [{
      id: 'refresh-a', sessionId: 'session-a', issuedAt: now - 1_000,
      expiresAt: now + 40_000, revokedAt: null, resourceAllowed: true, scopes: ['workspace:list'],
    }],
  });
  assert.equal(refreshed.authorizationStatus, 'usable');
  assert.equal(refreshed.usableGrantCount, 1);
  assert.equal(refreshed.refreshExpiresAt, new Date(now + 40_000).toISOString());
  assert.equal(evaluate({
    observedGrants: [],
    sessions: [{ ...session, grantRevokedAt: now - 500 }],
    refreshGrants: [{
      id: 'refresh-a', sessionId: 'session-a', issuedAt: now - 1_000,
      expiresAt: now + 40_000, revokedAt: null, resourceAllowed: true, scopes: ['workspace:list'],
    }],
  }).authorizationStatus, 'revoked', 'a direct grant revocation invalidates its refresh grant');
  assert.equal(evaluate({
    observedGrants: [{ ...access, sessionId: 'missing-session' }, access],
  }).authorizationStatus, 'usable', 'one stale observation cannot hide another proven usable grant');
  console.log('mcp-server-connection-usability-test: ok');
}

main();
