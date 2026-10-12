import type { CapabilityResourceOwnerScope, CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import type { CapabilityPolicyTargetType } from '@/app/lib/capabilities/types';
import type { IntegrationExecutionContext, IntegrationProviderScope, IntegrationSource } from '../contracts';
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';

/** New shared resources use the same ownership semantics as governed packages. */
export type SharedIntegrationConnectionOwnership = Extract<CapabilityResourceOwnerScope, { type: 'organization' | 'team' }>;
export type IntegrationConnectionActor = CapabilityResourceActor & {
  /** Runtime-only fields, supplied by a verified persisted agent session. */
  organizationId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  policyRevision?: string;
};

export type IntegrationConnectionAccess = { canRead: boolean; canUse: boolean; canManage: boolean };
export type IntegrationConnectionOperation = 'inspect' | 'use' | 'manage';
export type IntegrationConnectionGrantInput = {
  targetType: CapabilityPolicyTargetType | 'agent';
  targetId: string;
  canUse: boolean;
  canManage: boolean;
  /** null permits the resource's tool set; [] permits no provider actions. */
  allowedToolNames: string[] | null;
};
export type IntegrationConnectionGrant = IntegrationConnectionGrantInput & {
  id: string;
  connectionRef: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Public instance metadata never carries configuration, credentials or provider account IDs. */
export type IntegrationConnectionResource = {
  connectionRef: string;
  source: IntegrationSource;
  ownership: SharedIntegrationConnectionOwnership;
  displayName: string;
  description: string | null;
  application: string | null;
  responsibleUserId: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  metadataRevision: number;
  grantsRevision: number;
  bindingRevision: number;
  allowedToolNames: string[] | null;
  accessMode: 'restricted' | 'inherit';
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
};

/** Backend identities stay private and are checked by the owning provider service. */
export type IntegrationConnectionBackendBinding =
  | { source: 'mcp'; connectionId: string }
  | { source: 'composio'; profileId: string; toolkit: string; mode: 'local' | 'managed';
      accountBinding: 'pending' | 'account' | 'no_auth'; connectedAccountId: string | null };

export type IntegrationConnectionRecord = {
  resource: IntegrationConnectionResource;
  backend: IntegrationConnectionBackendBinding;
};
export type IntegrationConnectionDescriptor = {
  resource: IntegrationConnectionResource;
  access: IntegrationConnectionAccess;
  /** Exact referenced team label; this does not expose a workspace directory. */
  ownershipLabel?: string;
  /** Only managers receive the current grant set. */
  grants?: IntegrationConnectionGrant[];
};

export type IntegrationConnectionTargetCatalog = OrganizationPolicyTargetCatalog & {
  agents: Array<{ agentId: string; name: string }>;
};
export type IntegrationConnectionScopeChoice = { ownership: SharedIntegrationConnectionOwnership; label: string | null };
export type IntegrationConnectionRevisions = {
  metadataRevision: number;
  grantsRevision: number;
  bindingRevision: number;
};

export type SharedIntegrationConnectionCreation = {
  ownership: SharedIntegrationConnectionOwnership;
  displayName: string;
  description?: string | null;
  responsibleUserId?: string | null;
  accessMode?: 'restricted' | 'inherit';
  allowedToolNames?: string[] | null;
  grants?: IntegrationConnectionGrantInput[];
  /** Passed by the provider setup action, never accepted as a raw public record. */
  backend: IntegrationConnectionBackendBinding;
  /** Optional server-generated identity lets setup prepare a resource-bound backend. */
  connectionRef?: string;
};

export type IntegrationConnectionMutation = {
  expectedMetadataRevision: number;
  expectedGrantsRevision: number;
  expectedBindingRevision: number;
  metadata?: { displayName?: string; description?: string | null; responsibleUserId?: string | null };
  grants?: IntegrationConnectionGrantInput[];
  allowedToolNames?: string[] | null;
  accessMode?: 'restricted' | 'inherit';
  status?: 'active' | 'archived';
};

/** The common store issues this private authorization after fresh SQL authority checks. */
export type AuthorizedIntegrationConnection = IntegrationConnectionRecord & {
  actor: IntegrationConnectionActor;
  access: IntegrationConnectionAccess;
  operation: IntegrationConnectionOperation;
  allowedToolNames: readonly string[] | null;
  authorizationRevision: string;
};

export class IntegrationConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'IntegrationConnectionError';
    Object.defineProperty(this, Symbol.for('canvas.integration.connection-error.v1'), { value: true });
  }
}

export function isIntegrationConnectionError(value: unknown): value is IntegrationConnectionError {
  if (value instanceof IntegrationConnectionError) return true;
  if (!(value instanceof Error) || Reflect.get(value, Symbol.for('canvas.integration.connection-error.v1')) !== true) return false;
  const error = value as IntegrationConnectionError;
  return typeof error.code === 'string' && typeof error.message === 'string'
    && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
}

export function integrationConnectionActorFromContext(context: IntegrationExecutionContext): IntegrationConnectionActor {
  return { userId: context.actorUserId, workspaceId: context.workspaceId, organizationId: context.organizationId,
    agentId: context.agentId, sessionId: context.sessionId, policyRevision: context.policyRevision };
}

/** Ownership does not identify the requester or imply a grant in its execution workspace. */
export function integrationConnectionProviderScope(resource: IntegrationConnectionResource): IntegrationProviderScope {
  const owner = resource.ownership;
  return owner.type === 'team'
    ? { type: 'workspace', resourceId: resource.connectionRef, organizationId: owner.organizationId, workspaceId: owner.workspaceId }
    : { type: 'organization', resourceId: resource.connectionRef, organizationId: owner.organizationId };
}
