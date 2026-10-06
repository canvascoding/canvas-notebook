import 'server-only';

import type { IntegrationConnectionActor, IntegrationConnectionRecord, IntegrationConnectionRevisions } from '@/app/lib/integration-tools/connections/contracts';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { authorizeIntegrationConnection, withAuthorizedIntegrationConnection, publishIntegrationConnectionBinding } from '@/app/lib/integration-tools/connections/store';
import { startMcpOAuth, completeMcpOAuthCallback, rejectMcpOAuthCallback, clearMcpOAuth, getMcpOAuthStatus } from './oauth';
import { readMcpCredentialJson, writeMcpCredentialJson } from './credential-storage';
import { MCP_SYSTEM_SCOPE } from './scope';
import { sharedMcpScope } from './shared-access';
import { stageSharedMcpBindingPublication } from './shared-publication';
import { withMcpStorageLock } from './storage-lock';
import { removeMcpStoragePath } from './storage';
import { closeMcpServer } from './manager';

type SharedOAuthRoute = { connectionId: string; connectionRef: string; actor: IntegrationConnectionActor;
  revisions: IntegrationConnectionRevisions; authorizationRevision: string; expiresAt: string };
function routePath(state: string): string {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(state)) throw new IntegrationConnectionError('CONNECTION_OAUTH_STATE_INVALID', 'Invalid shared OAuth state.', 400);
  return `shared-oauth-routing/${state}.json`;
}
function backendId(record: IntegrationConnectionRecord): string {
  if (record.backend.source !== 'mcp') throw new IntegrationConnectionError('CONNECTION_BINDING_INVALID', 'Choose a shared MCP connection.');
  return record.backend.connectionId;
}

export async function startSharedMcpOAuth(actor: IntegrationConnectionActor, connectionRef: string,
  expected: IntegrationConnectionRevisions, origin: string): Promise<Awaited<ReturnType<typeof startMcpOAuth>>> {
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', structuredClone(expected), async authorization => {
    const result = await startMcpOAuth(backendId(authorization), origin, sharedMcpScope(authorization));
    try {
      await writeMcpCredentialJson(routePath(result.state), { connectionId: backendId(authorization), connectionRef,
        actor: authorization.actor, revisions: expected, authorizationRevision: authorization.authorizationRevision,
        expiresAt: result.expiresAt } satisfies SharedOAuthRoute, MCP_SYSTEM_SCOPE);
    } catch (error) {
      await rejectMcpOAuthCallback(result.state, null, sharedMcpScope(authorization)).catch(() => undefined);
      throw error;
    }
    return result;
  });
}

/** The callback is bound to its initiating manager and exact resource. No personal fallback exists. */
export async function completeSharedMcpOAuth(actor: IntegrationConnectionActor,
  input: { state: string; code?: string | null; error?: string | null; issuer?: string | null }): Promise<IntegrationConnectionRecord | null> {
  const captured = structuredClone(input);
  const route = await withMcpStorageLock(`shared-oauth-route-${captured.state}`, MCP_SYSTEM_SCOPE, async () => {
    const path = routePath(captured.state);
    const value = await readMcpCredentialJson<SharedOAuthRoute>(path, MCP_SYSTEM_SCOPE);
    if (!value || value.actor.userId !== actor.userId || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
      throw new IntegrationConnectionError('CONNECTION_OAUTH_STATE_INVALID', 'This shared sign-in is expired or belongs to another manager.', 409);
    }
    await removeMcpStoragePath(path, MCP_SYSTEM_SCOPE);
    return value;
  });
  return withAuthorizedIntegrationConnection(route.actor, route.connectionRef, 'manage', route.revisions, async authorization => {
    if (backendId(authorization) !== route.connectionId || authorization.authorizationRevision !== route.authorizationRevision) {
      throw new IntegrationConnectionError('CONNECTION_BINDING_CHANGED', 'Shared sign-in permissions changed. Start sign-in again.', 409);
    }
    const scope = sharedMcpScope(authorization);
    if (captured.error) { await rejectMcpOAuthCallback(captured.state, captured.issuer, scope); return null; }
    if (!captured.code) throw new IntegrationConnectionError('CONNECTION_OAUTH_STATE_INVALID', 'Missing shared authorization code.', 400);
    await stageSharedMcpBindingPublication(authorization);
    await completeMcpOAuthCallback(captured.code, captured.state, captured.issuer, scope);
    await closeMcpServer(route.connectionId, scope);
    return publishIntegrationConnectionBinding(route.actor, route.connectionRef, route.revisions, authorization.backend);
  });
}

export async function disconnectSharedMcpOAuth(actor: IntegrationConnectionActor, connectionRef: string,
  expected: IntegrationConnectionRevisions): Promise<IntegrationConnectionRecord> {
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', structuredClone(expected), async authorization => {
    await stageSharedMcpBindingPublication(authorization);
    await clearMcpOAuth(backendId(authorization), sharedMcpScope(authorization));
    return publishIntegrationConnectionBinding(actor, connectionRef, expected, authorization.backend);
  });
}

export async function readSharedMcpOAuthState(actor: IntegrationConnectionActor, connectionRef: string) {
  const authorization = await authorizeIntegrationConnection(actor, connectionRef, 'inspect');
  const status = await getMcpOAuthStatus(backendId(authorization), null, sharedMcpScope(authorization));
  return { configured: status.configured, requiresAuth: status.requiresAuth, authorized: status.authorized,
    authStatus: status.authStatus, code: status.code ?? null };
}
