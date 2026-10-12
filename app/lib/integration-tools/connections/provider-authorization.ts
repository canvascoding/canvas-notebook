import {
  IntegrationContractError,
  type IntegrationExecutionContext,
  type IntegrationProviderDescriptor,
} from '../contracts';
import { createIntegrationProviderRef } from '../references';
import {
  integrationConnectionActorFromContext,
  integrationConnectionProviderScope,
  type AuthorizedIntegrationConnection,
  type IntegrationConnectionOperation,
  type IntegrationConnectionResource,
} from './contracts';

type Proof = {
  authorization: AuthorizedIntegrationConnection;
  contextKey: string;
  identity: string;
  authorizationSnapshot: string;
  valid: () => boolean;
};

// Kept outside DTOs: spreading or serializing a descriptor never creates authority.
// A shared WeakMap also preserves provenance across server module copies.
const host = globalThis as typeof globalThis & { __canvasIntegrationProviderAuthorizationV1?: WeakMap<object, Proof> };
const proofs = host.__canvasIntegrationProviderAuthorizationV1 ??= new WeakMap<object, Proof>();

function contextKey(context: IntegrationExecutionContext): string {
  return JSON.stringify([context.actorUserId, context.organizationId ?? null, context.workspaceId ?? null,
    context.agentId ?? null, context.sessionId ?? null, context.policyRevision]);
}

function authorizationContextKey(authorization: AuthorizedIntegrationConnection): string {
  const actor = authorization.actor;
  return JSON.stringify([actor.userId, actor.organizationId ?? null, actor.workspaceId ?? null,
    actor.agentId ?? null, actor.sessionId ?? null, actor.policyRevision]);
}

function providerIdentity(provider: IntegrationProviderDescriptor): string {
  return JSON.stringify([provider.providerRef, provider.source, provider.application ?? null, provider.scope]);
}

/** Stable public identity belongs to the connection resource, never a foreign backend account. */
export function createSharedIntegrationProviderRef(resource: IntegrationConnectionResource): string {
  const scope = integrationConnectionProviderScope(resource);
  const identity = resource.source === 'mcp'
    ? createIntegrationProviderRef({ source: 'mcp', scope, connectionId: resource.connectionRef })
    : createIntegrationProviderRef({ source: 'composio', scope, profileId: resource.connectionRef, toolkit: resource.application || '' });
  const ref = `${resource.source}:v1:shared:${Buffer.from(resource.connectionRef, 'utf8').toString('base64url')}:${identity.split(':').at(-1)}`;
  if (ref.length > 256) throw new IntegrationContractError('provider_denied', 'The shared integration reference is invalid.');
  return ref;
}

/** Issued only after the common store has authorized this exact actor and resource. */
export async function attachIntegrationProviderAuthorization(
  context: IntegrationExecutionContext,
  provider: IntegrationProviderDescriptor,
  authorization: AuthorizedIntegrationConnection,
): Promise<void> {
  const { isAuthorizedIntegrationConnection } = await import('./store');
  const scope = integrationConnectionProviderScope(authorization.resource);
  if (!isAuthorizedIntegrationConnection(authorization)
    || authorizationContextKey(authorization) !== contextKey(context)
    || authorization.resource.status !== 'active'
    || !authorization.access.canRead
    || authorization.resource.source !== provider.source
    || authorization.resource.application !== (provider.application ?? null)
    || JSON.stringify(scope) !== JSON.stringify(provider.scope)
    || createSharedIntegrationProviderRef(authorization.resource) !== provider.providerRef) {
    throw new IntegrationContractError('provider_denied', 'The shared integration connection could not be authorized.');
  }
  const authorizationSnapshot = JSON.stringify(authorization);
  proofs.set(provider, { authorization, contextKey: contextKey(context), identity: providerIdentity(provider),
    authorizationSnapshot, valid: () => isAuthorizedIntegrationConnection(authorization) });
}

export function getIntegrationProviderAuthorization(
  context: IntegrationExecutionContext,
  provider: IntegrationProviderDescriptor,
): AuthorizedIntegrationConnection | null {
  const proof = proofs.get(provider);
  return proof && proof.valid() && proof.contextKey === contextKey(context)
    && proof.identity === providerIdentity(provider)
    && proof.authorizationSnapshot === JSON.stringify(proof.authorization)
    ? proof.authorization : null;
}

/** A controlled server projection may retain a proof only for its unchanged resource identity. */
export function transferIntegrationProviderAuthorization(
  context: IntegrationExecutionContext,
  original: IntegrationProviderDescriptor,
  projected: IntegrationProviderDescriptor,
): IntegrationProviderDescriptor {
  const proof = proofs.get(original);
  if (proof && getIntegrationProviderAuthorization(context, original)
    && proof.identity === providerIdentity(projected)) proofs.set(projected, proof);
  return projected;
}

export function integrationProviderAllowedToolNames(
  context: IntegrationExecutionContext,
  provider: IntegrationProviderDescriptor,
  allowedToolNames: readonly string[] | null | undefined,
): readonly string[] | null {
  const authorized = getIntegrationProviderAuthorization(context, provider);
  const requested = allowedToolNames ?? null;
  if (!authorized) return requested;
  if (!authorized.access.canUse) return [];
  const resource = authorized.allowedToolNames;
  return requested === null ? resource : resource === null ? requested : requested.filter(name => resource.includes(name));
}

/** Permission checks precede backend discovery, including calls using cached references. */
export async function findSharedIntegrationConnectionAuthorization(
  context: IntegrationExecutionContext,
  providerRef: string,
  operation: IntegrationConnectionOperation = 'inspect',
  toolName?: string,
): Promise<AuthorizedIntegrationConnection | null> {
  if (!/^(mcp|composio):v1:shared:/u.test(providerRef)) return null;
  const parts = providerRef.split(':');
  if (parts.length !== 5 || providerRef.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(parts[3])
    || !/^[A-Za-z0-9_-]{43}$/u.test(parts[4])) {
    throw new IntegrationContractError('provider_denied', 'The shared integration reference is invalid.');
  }
  const ref = Buffer.from(parts[3], 'base64url').toString('utf8');
  if (Buffer.from(ref, 'utf8').toString('base64url') !== parts[3] || !/^canvas-connection:[a-f0-9-]{36}$/u.test(ref)) {
    throw new IntegrationContractError('provider_denied', 'The shared integration reference is invalid.');
  }
  const { getIntegrationConnectionRecord, authorizeIntegrationConnection } = await import('./store');
  const actor = integrationConnectionActorFromContext(context);
  const record = await getIntegrationConnectionRecord(ref);
  if (!record || createSharedIntegrationProviderRef(record.resource) !== providerRef) {
    throw new IntegrationContractError('provider_denied', 'The shared integration connection is not available.');
  }
  try { return await authorizeIntegrationConnection(actor, record.resource.connectionRef, operation, toolName); }
  catch { throw new IntegrationContractError('provider_denied', 'The shared integration connection is not available to this agent.'); }
}

export async function revalidateIntegrationProviderAuthorization(
  context: IntegrationExecutionContext,
  provider: IntegrationProviderDescriptor,
  operation: IntegrationConnectionOperation = 'inspect',
  toolName?: string,
): Promise<void> {
  const authorization = getIntegrationProviderAuthorization(context, provider);
  if (!authorization) {
    if (proofs.has(provider)) throw new IntegrationContractError('provider_denied', 'The shared integration authority changed.');
    return;
  }
  const { revalidateAuthorizedIntegrationConnection } = await import('./store');
  let current: AuthorizedIntegrationConnection;
  try { current = await revalidateAuthorizedIntegrationConnection(authorization, operation, toolName); }
  catch { throw new IntegrationContractError('provider_denied', 'The shared integration connection is no longer authorized.'); }
  if (current.authorizationRevision !== authorization.authorizationRevision) {
    throw new IntegrationContractError('binding_changed', 'The shared integration connection or its grants changed. Load its schema again.');
  }
}
