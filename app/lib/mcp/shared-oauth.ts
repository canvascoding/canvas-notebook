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
import { createSharedConnectionOAuthReturn, validateSharedConnectionOAuthReturn, type SharedConnectionOAuthReturnContext } from '@/app/lib/integration-tools/connections/oauth-return';
import { assertSharedMcpDesktopOAuthSession } from './shared-desktop-oauth';

type SharedOAuthRoute = { connectionId: string; connectionRef: string; actor: IntegrationConnectionActor;
  revisions: IntegrationConnectionRevisions; authorizationRevision: string; expiresAt: string;
  returnContext?: SharedConnectionOAuthReturnContext; appOrigin?: string };
function routePath(state: string): string {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(state)) throw new IntegrationConnectionError('CONNECTION_OAUTH_STATE_INVALID', 'Invalid shared OAuth state.', 400);
  return `shared-oauth-routing/${state}.json`;
}
function backendId(record: IntegrationConnectionRecord): string {
  if (record.backend.source !== 'mcp') throw new IntegrationConnectionError('CONNECTION_BINDING_INVALID', 'Choose a shared MCP connection.');
  return record.backend.connectionId;
}

export async function startSharedMcpOAuth(actor: IntegrationConnectionActor, connectionRef: string,
  expected: IntegrationConnectionRevisions, origin: string,
  options: { returnLocale?: 'de' | 'en'; catalogReturnPath?: string; desktop?: { authSessionId: string };
    onCreated?: (created: Awaited<ReturnType<typeof startMcpOAuth>>) => Promise<void> } = {}): Promise<Awaited<ReturnType<typeof startMcpOAuth>>> {
  if (options.catalogReturnPath !== undefined && (options.returnLocale === undefined || options.desktop)) throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'A catalog return requires a browser locale.', 400);
  if (options.onCreated && !options.desktop) throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'A native locator requires its original session.', 400);
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', structuredClone(expected), async (authorization, database) => {
    const returnContext = options.returnLocale === undefined ? undefined
      : createSharedConnectionOAuthReturn(authorization.resource, authorization.actor, options.returnLocale, options.catalogReturnPath);
    const initiator = options.desktop ? { actor: authorization.actor, authSessionId: options.desktop.authSessionId } : undefined;
    if (initiator) await assertSharedMcpDesktopOAuthSession(database, initiator);
    const result = await startMcpOAuth(backendId(authorization), origin, sharedMcpScope(authorization), initiator ? {
      desktop: true, sharedDesktopInitiator: { authSessionId: initiator.authSessionId },
      assertAuthorization: () => assertSharedMcpDesktopOAuthSession(database, initiator),
    } : {});
    if (initiator) { await options.onCreated?.(result); return result; }
    try {
      await writeMcpCredentialJson(routePath(result.state), { connectionId: backendId(authorization), connectionRef,
        actor: authorization.actor, revisions: expected, authorizationRevision: authorization.authorizationRevision,
        expiresAt: result.expiresAt, ...(returnContext ? { returnContext, appOrigin: new URL(result.redirectUri).origin } : {}) } satisfies SharedOAuthRoute, MCP_SYSTEM_SCOPE);
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
  return (await completeSharedMcpOAuthWithReturn(actor, input)).record;
}

export async function completeSharedMcpOAuthWithReturn(actor: IntegrationConnectionActor,
  input: { state: string; code?: string | null; error?: string | null; issuer?: string | null }): Promise<{
    record: IntegrationConnectionRecord | null; returnContext?: SharedConnectionOAuthReturnContext; appOrigin?: string;
  }> {
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
    let returnContext: SharedConnectionOAuthReturnContext | undefined, appOrigin: string | undefined;
    if (route.returnContext !== undefined || route.appOrigin !== undefined) {
      validateSharedConnectionOAuthReturn(route.returnContext, authorization.resource, route.actor);
      if (typeof route.appOrigin !== 'string') throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The shared sign-in return origin is invalid.');
      const savedOrigin = new URL(route.appOrigin);
      if (!['http:', 'https:'].includes(savedOrigin.protocol) || savedOrigin.origin !== route.appOrigin || savedOrigin.username || savedOrigin.password) {
        throw new IntegrationConnectionError('CONNECTION_OAUTH_RETURN_INVALID', 'The shared sign-in return origin is invalid.');
      }
      returnContext = structuredClone(route.returnContext); appOrigin = savedOrigin.origin;
    }
    const scope = sharedMcpScope(authorization);
    if (captured.error) {
      await rejectMcpOAuthCallback(captured.state, captured.issuer, scope);
      if (returnContext && captured.error !== 'access_denied') throw new IntegrationConnectionError('CONNECTION_OAUTH_PROVIDER_ERROR', 'The provider could not complete shared sign-in.');
      return { record: null, ...(returnContext ? { returnContext, appOrigin } : {}) };
    }
    if (!captured.code) throw new IntegrationConnectionError('CONNECTION_OAUTH_STATE_INVALID', 'Missing shared authorization code.', 400);
    await stageSharedMcpBindingPublication(authorization);
    await completeMcpOAuthCallback(captured.code, captured.state, captured.issuer, scope);
    await closeMcpServer(route.connectionId, scope);
    const record = await publishIntegrationConnectionBinding(route.actor, route.connectionRef, route.revisions, authorization.backend);
    return { record, ...(returnContext ? { returnContext, appOrigin } : {}) };
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
