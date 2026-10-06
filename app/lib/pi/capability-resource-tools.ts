import 'server-only';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { RemoveOptional, Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import { CapabilityResourceReferenceSchema, CapabilityResourceMutationSchema, CapabilityResourceMetadataPatchSchema,
  CapabilityResourceOwnershipChoiceSchema } from '@/app/lib/capabilities/resources/schemas';
import {
  configureCapabilityResource,
  inspectCapabilityResource,
  listCapabilityResources,
  listCapabilityResourceTargets,
  updateCapabilityResource,
} from '@/app/lib/capabilities/resources/actions';
import {
  CapabilityResourceError,
  type CapabilityResourceActor,
  type CapabilityResourceConfiguration,
  type CapabilityResourceMetadataPatch,
  type CapabilityResourceGrantInput,
} from '@/app/lib/capabilities/resources/contracts';
import { getAgentExecutionContext } from './agent-execution-context';

export const CAPABILITY_RESOURCE_TOOL_NAMES = [
  'inspect_canvas_resource', 'configure_canvas_resource', 'update_canvas_resource_metadata',
  'set_canvas_resource_grants', 'list_canvas_resource_targets',
] as const;

const reference = CapabilityResourceReferenceSchema;
const revision = CapabilityResourceMutationSchema.properties.expectedMetadataRevision;
const metadata = CapabilityResourceMetadataPatchSchema;
const grants = RemoveOptional(CapabilityResourceMutationSchema.properties.grants);
const accessMode = RemoveOptional(CapabilityResourceMutationSchema.properties.accessMode);
const ownership = CapabilityResourceOwnershipChoiceSchema;
const revisions = { resourceRef: reference, expectedMetadataRevision: revision, expectedGrantsRevision: revision };

function executionActor(userId?: string, agentId?: string | null, sessionId?: string | null): CapabilityResourceActor {
  const context = getAgentExecutionContext();
  if (!userId || !context?.userId || !context.sessionId || !context.workspaceId
    || context.userId !== userId || (sessionId && context.sessionId !== sessionId)
    || (agentId && context.agentId !== agentId)) {
    throw new CapabilityResourceError('resource_execution_context_required', 'An authenticated matching agent session is required.', 403);
  }
  return { userId: context.userId, workspaceId: context.workspaceId };
}

export function createCapabilityResourceTools(userId?: string, agentId?: string | null, sessionId?: string | null): AgentTool[] {
  const tool = (name: string, label: string, description: string, parameters: TSchema,
    operation: (actor: CapabilityResourceActor, params: Record<string, unknown>) => Promise<unknown>): AgentTool => ({
    name, label, description, parameters,
    execute: async (_toolCallId, params) => {
      try {
        const actor = executionActor(userId, agentId, sessionId);
        if (!Check(parameters, params)) throw new CapabilityResourceError('invalid_request', 'Invalid resource tool arguments.');
        const result = await operation(actor, params as Record<string, unknown>);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { capabilityResource: { operation: name, result } } };
      } catch (error) {
        const known = error instanceof CapabilityResourceError;
        const code = known ? error.code : error instanceof Error && error.name === 'ZodError' ? 'invalid_request' : 'resource_unavailable';
        const message = known ? error.message : code === 'invalid_request' ? 'Invalid resource tool arguments.' : 'Resource management is currently unavailable.';
        return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message, code } };
      }
    },
  });
  return [
    tool('inspect_canvas_resource', 'Inspecting Canvas resource',
      'Lists visible installed plugin/skill resources when resourceRef is omitted, or inspects one exact resource. Returns server-issued references, independent edit/manage/use permissions, and metadata/grants revisions. Inspect before any mutation; it never reads credentials or artifact contents.',
      Type.Object({ resourceRef: Type.Optional(reference), query: Type.Optional(Type.String({ maxLength: 256 })),
        resourceType: Type.Optional(Type.Union([Type.Literal('plugin'), Type.Literal('skill')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      async (actor, params) => {
        if (params.resourceRef) return inspectCapabilityResource(actor, params.resourceRef as string);
        const query = (params.query as string | undefined)?.trim().toLowerCase();
        const matching = (await listCapabilityResources(actor)).filter(resource => (!params.resourceType || resource.artifact.resourceType === params.resourceType)
          && (!query || `${resource.artifact.name} ${resource.metadata.displayName || ''} ${resource.metadata.description || ''}`.toLowerCase().includes(query)));
        const limit = (params.limit as number | undefined) ?? 25;
        return { resources: matching.slice(0, limit).map(resource => ({ resourceRef: resource.metadata.resourceRef,
          name: resource.artifact.name, resourceType: resource.artifact.resourceType, displayName: resource.metadata.displayName,
          ownership: resource.metadata.ownership, access: resource.access,
          metadataRevision: resource.metadata.metadataRevision, grantsRevision: resource.metadata.grantsRevision })),
          total: matching.length, truncated: matching.length > limit };
      }),
    tool('configure_canvas_resource', 'Configuring Canvas resource',
      'Adopts an existing unmanaged installed plugin/skill into explicit personal, organization, or team resource management. Requires resource-manager permission and both inspection revisions equal zero. It never creates, copies, promotes, or reconnects a package. Owner and organization identities are derived by the server. Use only for an explicit user configuration request.',
      Type.Object({ resourceRef: reference, expectedMetadataRevision: Type.Literal(0), expectedGrantsRevision: Type.Literal(0), ownership,
        metadata: Type.Optional(metadata), grants: Type.Optional(grants), accessMode: Type.Optional(accessMode) }, { additionalProperties: false }),
      async (actor, params) => {
        const { resourceRef, ...input } = params;
        return configureCapabilityResource(actor, resourceRef as string, input as CapabilityResourceConfiguration);
      }),
    tool('update_canvas_resource_metadata', 'Updating Canvas resource metadata',
      'Updates displayName/description with resource edit permission. Changing responsibleUserId additionally requires resource management permission. Requires both fresh revisions from inspect_canvas_resource. Package bytes, version, checksum, ownership and connection credentials remain governed by their own actions.',
      Type.Object({ ...revisions, metadata }, { additionalProperties: false }),
      async (actor, params) => updateCapabilityResource(actor, params.resourceRef as string, {
        expectedMetadataRevision: params.expectedMetadataRevision as number, expectedGrantsRevision: params.expectedGrantsRevision as number,
        metadata: params.metadata as CapabilityResourceMetadataPatch,
      })),
    tool('set_canvas_resource_grants', 'Setting Canvas resource access',
      'Atomically replaces the exact resource grant list, optionally selecting inherited or restricted access. Each canUse/canEdit/canManage flag is independent and must be explicit; edit/manage never grants execution. Requires fresh resource-manager permission, both current revisions and valid targets from list_canvas_resource_targets. Use only for an explicit user sharing request.',
      Type.Object({ ...revisions, grants, accessMode: Type.Optional(accessMode) }, { additionalProperties: false }),
      async (actor, params) => updateCapabilityResource(actor, params.resourceRef as string, {
        expectedMetadataRevision: params.expectedMetadataRevision as number, expectedGrantsRevision: params.expectedGrantsRevision as number,
        grants: params.grants as CapabilityResourceGrantInput[], ...(params.accessMode ? { accessMode: params.accessMode as 'inherit' | 'restricted' } : {}),
      })),
    tool('list_canvas_resource_targets', 'Listing Canvas resource access targets',
      'Lists the active organization users, workspaces and projects that this resource manager may select. It cannot enroll users, change membership or expand authority. Other users cannot read the grant-management catalog.',
      Type.Object({ resourceRef: reference }, { additionalProperties: false }),
      async (actor, params) => listCapabilityResourceTargets(actor, params.resourceRef as string)),
  ];
}
