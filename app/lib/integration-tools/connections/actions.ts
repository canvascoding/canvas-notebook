import 'server-only';

import { z } from 'zod';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import { IntegrationConnectionError, type IntegrationConnectionActor, type IntegrationConnectionDescriptor,
  type SharedIntegrationConnectionOwnership } from './contracts';
import { createSharedIntegrationConnection, inspectSharedIntegrationConnection, mutateSharedIntegrationConnection } from './store';

export const sharedConnectionOwnershipSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('team'), workspaceId: z.string().min(1).max(256) }).strict(),
]);
const toolNames = z.array(z.string().min(1).max(512)).max(1000).nullable();
const grant = z.object({ targetType: z.enum(['organization', 'role', 'workspace', 'project', 'user', 'agent']),
  targetId: z.string().min(1).max(200), canUse: z.boolean(), canManage: z.boolean(), allowedToolNames: toolNames }).strict();
const metadata = { displayName: z.string().min(1).max(200), description: z.string().max(4096).nullable().optional(),
  responsibleUserId: z.string().min(1).max(200).nullable().optional() };
const creation = { ...metadata, ownership: sharedConnectionOwnershipSchema, accessMode: z.enum(['restricted', 'inherit']).optional(),
  allowedToolNames: toolNames.optional(), grants: z.array(grant).max(100).optional() };
const createSchema = z.discriminatedUnion('source', [
  z.object({ ...creation, source: z.literal('composio'), profileId: z.string().min(1).max(200), toolkit: z.string().min(1).max(100) }).strict(),
  z.object({ ...creation, source: z.literal('mcp'), definitionId: z.string().min(1).max(200).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secrets: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(16384) }).strict()).max(50).optional() }).strict(),
]);
const mutationSchema = z.object({ expectedMetadataRevision: z.number().int().positive(), expectedGrantsRevision: z.number().int().positive(),
  expectedBindingRevision: z.number().int().positive(), metadata: z.object({ displayName: metadata.displayName.optional(),
    description: metadata.description, responsibleUserId: metadata.responsibleUserId }).strict().optional(),
  grants: z.array(grant).max(100).optional(), allowedToolNames: toolNames.optional(), accessMode: z.enum(['restricted', 'inherit']).optional(),
  status: z.enum(['active', 'archived']).optional() }).strict();

/** The organization comes from the authenticated actor's configured instance, never request JSON. */
export async function resolveSharedConnectionOwnership(actor: IntegrationConnectionActor,
  value: unknown): Promise<SharedIntegrationConnectionOwnership> {
  const choice = sharedConnectionOwnershipSchema.parse(value), state = await readOrganizationPermissionForUser(actor.userId);
  if (!state.configured || state.permission?.status !== 'active' || !state.organizationId) {
    throw new IntegrationConnectionError('CONNECTION_ACCESS_DENIED', 'An active organization membership is required.', 403);
  }
  return choice.type === 'organization' ? { type: 'organization', organizationId: state.organizationId }
    : { type: 'team', organizationId: state.organizationId, workspaceId: choice.workspaceId };
}

/** Shared by UI and agent management; no raw account, owner, provider mode or credential identity is accepted. */
export async function createSharedConnection(actorInput: IntegrationConnectionActor, value: unknown): Promise<IntegrationConnectionDescriptor> {
  const actor = structuredClone(actorInput), input = createSchema.parse(structuredClone(value));
  const ownership = await resolveSharedConnectionOwnership(actor, input.ownership);
  let ref: string;
  if (input.source === 'mcp') {
    const { createSharedMcpConnection } = await import('@/app/lib/mcp/shared-connections');
    const { source: _source, config, ...request } = input;
    const record = await createSharedMcpConnection(actor, { ...request, ownership, ...(config ? { config: config as unknown as McpServerConfig } : {}) });
    ref = record.resource.connectionRef;
  } else {
    const { prepareSharedComposioConnectionBackend } = await import('@/app/lib/composio/composio-shared-backend');
    const backend = await prepareSharedComposioConnectionBackend(actor, { profileId: input.profileId, toolkit: input.toolkit, ownership });
    const { source: _source, profileId: _profile, toolkit: _toolkit, ...request } = input;
    const record = await createSharedIntegrationConnection(actor, { ...request, ownership, backend });
    ref = record.resource.connectionRef;
  }
  return inspectSharedIntegrationConnection(actor, ref);
}

export async function updateSharedConnection(actor: IntegrationConnectionActor, connectionRef: string,
  value: unknown): Promise<IntegrationConnectionDescriptor> {
  return mutateSharedIntegrationConnection(actor, connectionRef, mutationSchema.parse(structuredClone(value)));
}
