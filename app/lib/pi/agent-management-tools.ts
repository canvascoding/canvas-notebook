import 'server-only';

import { type AgentTool, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { z } from 'zod';
import { updateManagedAgentConfiguration, inspectManagedAgentWorkflow, listManagedAgentWorkflowOptions,
  setManagedAgentWorkflowChoice } from '@/app/lib/agents/workflow-configuration';
import { agentWorkflowPersonalOptionsSchema, bindOwnAgentWorkflowChoiceInput, createAgentConfigurationSchema,
  updateAgentConfigurationSchema, updateAgentWorkflowChoiceSchema } from '@/app/lib/agents/workflow-api-contracts';
import { agentWorkflowManagementPersonalConnectionsRequestSchema, agentWorkflowManagementRequestSchema } from '@/app/lib/agents/workflow-management-contracts';
import { listAgentWorkflowManagementOptions } from '@/app/lib/agents/workflow-management';

import {
  AgentManagementError,
  managementErrorDetails,
  createManagedAgent,
  deleteManagedAgent,
  inspectManagedAgent,
  listManagedAgents,
  previewManagedAgentDeletion,
  removeManagedAgentGrant,
  setManagedAgentGrant,
  updateManagedAgentCapabilities,
  updateManagedAgentFile,
  updateManagedAgentProfile,
  updateManagedAgentRuntime,
  type AgentManagementActor,
} from '@/app/lib/agents/management-actions';
import { DEFAULT_MANAGED_AGENT_ID, type AgentManagedFileName } from '@/app/lib/agents/storage';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

const nullableString = Type.Union([Type.String(), Type.Null()]);
// The Planning-whitelisted operation always remains local metadata. Explicit
// account discovery belongs to the existing non-whitelisted personal tool.
const [firstManagementMetadataSchema, ...remainingManagementMetadataSchemas] = agentWorkflowManagementRequestSchema.options
  .map(schema => schema.shape.view.value === 'personal-connections'
    ? agentWorkflowManagementPersonalConnectionsRequestSchema.omit({ providerRef: true }) : schema);
const agentWorkflowManagementMetadataToolSchema = z.discriminatedUnion('view',
  [firstManagementMetadataSchema, ...remainingManagementMetadataSchemas]);
const agentWorkflowOptionsToolSchema = z.union([
  z.object({ agentId: z.string().min(1).max(256), view: z.literal('options').optional() }).strict(),
  agentWorkflowManagementMetadataToolSchema,
]);
const agentWorkflowPersonalToolSchema = z.union([
  agentWorkflowPersonalOptionsSchema,
  agentWorkflowManagementPersonalConnectionsRequestSchema.required({ providerRef: true }),
]);
const capabilitySelectionSchema = Type.Object({
  resourceType: Type.Union([Type.Literal('skill'), Type.Literal('plugin')]),
  resourceId: Type.Optional(Type.String({ description: 'Stable capability resource ID from inspect/search results.' })),
  name: Type.Optional(Type.String({ description: 'Capability name; resourceId is preferred when known.' })),
  requirement: Type.Optional(Type.Union([Type.Literal('optional'), Type.Literal('required')])),
});
const grantTargetTypeSchema = Type.Union([
  Type.Literal('organization'),
  Type.Literal('role'),
  Type.Literal('workspace'),
  Type.Literal('project'),
  Type.Literal('user'),
]);
const grantSchema = Type.Object({
  targetType: grantTargetTypeSchema,
  targetId: Type.String(),
  canUse: Type.Optional(Type.Boolean()),
  canEdit: Type.Optional(Type.Boolean()),
  canManage: Type.Optional(Type.Boolean()),
});

function result(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details };
}

/** Direct read-only calls and grouped mutations share the public error boundary. */
function protectWorkflowTool(tool: AgentTool): AgentTool {
  return { ...tool, execute: async (...args) => {
    try { return await tool.execute(...args); }
    catch (error) {
      if (error instanceof z.ZodError) throw new AgentManagementError('AGENT_WORKFLOW_INVALID', 'The workflow request contains invalid or unsupported fields.', 400);
      const publicError = managementErrorDetails(error);
      throw new AgentManagementError(publicError.code, publicError.message, publicError.status, publicError.details);
    }
  } };
}

function actor(userId: string, sessionId?: string | null): AgentManagementActor {
  const context = getAgentExecutionContext();
  if (context && context.userId !== userId) {
    throw new Error('Agent management execution context does not match the active user.');
  }
  return {
    userId,
    sessionId: context?.sessionId || sessionId,
    source: 'tool',
    sourceAgentId: context?.agentId || DEFAULT_MANAGED_AGENT_ID,
    organizationId: context?.organizationId,
    workspaceId: context?.workspaceId,
    projectId: context?.projectId,
  };
}

function ensureMainAgent(agentId?: string | null): void {
  if ((agentId?.trim().toLowerCase() || DEFAULT_MANAGED_AGENT_ID) !== DEFAULT_MANAGED_AGENT_ID) {
    throw new Error('Full agent management tools are available only to Bradley, the main agent.');
  }
}

export const AGENT_MANAGEMENT_OPERATION_NAMES = [
  'create_agent',
  'update_agent_profile',
  'update_agent_runtime',
  'update_agent_capabilities',
  'update_agent_configuration',
  'set_agent_workflow_choice',
  'update_agent_file',
  'set_agent_grant',
  'remove_agent_grant',
  'preview_agent_deletion',
  'delete_agent',
] as const;

export function createAgentManagementTools(
  userId?: string,
  agentId?: string | null,
  sessionId?: string | null,
): AgentTool[] {
  if (!userId) return [];
  ensureMainAgent(agentId);

  const listAgents: AgentTool = {
    name: 'list_agents',
    label: 'List agents',
    description: 'Lists Bradley plus personal and organization agents available to this user, including scope, revision, and effective access. This is read-only and planning-safe.',
    parameters: Type.Object({}),
    execute: async () => {
      const agents = await listManagedAgents(actor(userId, sessionId));
      return result(
        agents.length === 0
          ? 'No managed agents are available.'
          : agents.map((entry) => `- ${entry.name} (${entry.agentId}) — ${entry.scopeType}, revision ${entry.revision}`).join('\n'),
        { agents },
      );
    },
  };

  const inspectAgent: AgentTool = {
    name: 'inspect_agent',
    label: 'Inspect agent',
    description: 'Inspects one agent for use or configuration. The default purpose use requires Use permission; purpose configure requires Edit permission. Profile, runtime, complete extensions, readiness, and access are returned; managed-file contents and grants require matching edit/manage access.',
    parameters: Type.Object({
      agentId: Type.String(),
      purpose: Type.Optional(Type.Union([Type.Literal('use'), Type.Literal('configure')])),
      includeFiles: Type.Optional(Type.Boolean()),
      includeAccess: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const input = params as { agentId: string; purpose?: 'use' | 'configure'; includeFiles?: boolean; includeAccess?: boolean };
      const inspected = await inspectManagedAgent(actor(userId, sessionId), input.agentId, input);
      return result(
        `${inspected.agent.name} (${inspected.agent.agentId}) is a ${inspected.agent.scopeType} agent at revision ${inspected.agent.revision}.`,
        inspected,
      );
    },
  };

  const createAgent: AgentTool = {
    name: 'create_agent',
    label: 'Create agent',
    description: 'Creates a complete personal or organization agent with profile, runtime defaults, native tool limits, exact plugin/skill pins, standalone MCP/Composio fixed or selectable connections, instruction files and optional grants. Use extensions for the complete fixed or explicit legacy-inherit configuration; do not combine it with legacy capability fields. Fresh personal account choices require the current server-issued receipt. Organization agents require owner/admin permission.',
    parameters: Type.Unsafe(z.toJSONSchema(createAgentConfigurationSchema, { target: 'draft-7', io: 'input' })),
    execute: async (_toolCallId, params) => {
      const input = createAgentConfigurationSchema.parse(params);
      const created = await createManagedAgent(actor(userId, sessionId), input);
      return result(
        `Created ${created.agent.scopeType} agent ${created.agent.name} (${created.agent.agentId}) at revision ${created.agent.revision}.`,
        created,
      );
    },
  };

  const personalWorkflowOptions: AgentTool = {
    name: 'list_agent_workflow_personal_options', label: 'Find own workflow connections',
    description: 'Explicit discovery for a centrally allowed personal workflow choice. Start with agentId/capabilityKey to list your permitted providers without external requests, then select a returned alternativeKey/providerRef for its exact account chooser. Central editors may instead use view=personal-connections with the exact published declaration, agent/workflow revisions and a providerRef returned by list_agent_workflow_options. Return only server-issued references. This can query external account metadata and is unavailable in planning mode; it never changes a binding.',
    parameters: Type.Unsafe(z.toJSONSchema(agentWorkflowPersonalToolSchema, { target: 'draft-7', io: 'input' })),
    execute: async (_toolCallId, params) => {
      const input = agentWorkflowPersonalToolSchema.parse(params);
      if ('view' in input) {
        const data = await listAgentWorkflowManagementOptions(actor(userId, sessionId), input);
        return result('Your exact personal account options for central configuration.', { management: data });
      }
      const { listAgentWorkflowPersonalOptions } = await import('@/app/lib/agents/workflow-personal-options');
      const data = await listAgentWorkflowPersonalOptions(actor(userId, sessionId), input);
      return result('Your permitted personal workflow connections.', { options: data });
    },
  };

  const updateProfile: AgentTool = {
    name: 'update_agent_profile',
    label: 'Update agent profile',
    description: 'Updates an agent name or icon using optimistic revision control. Agent scope is immutable after creation.',
    parameters: Type.Object({
      agentId: Type.String(),
      expectedRevision: Type.Number(),
      name: Type.Optional(Type.String()),
      iconId: Type.Optional(nullableString),
    }),
    execute: async (_toolCallId, params) => {
      const updated = await updateManagedAgentProfile({ actor: actor(userId, sessionId), ...(params as Omit<Parameters<typeof updateManagedAgentProfile>[0], 'actor'>) });
      return result(`Updated ${updated.agentId} to revision ${updated.revision}.`, { agent: updated });
    },
  };

  const updateRuntime: AgentTool = {
    name: 'update_agent_runtime',
    label: 'Update agent runtime',
    description: 'Updates enabled tools and optional provider/model/thinking defaults. Model defaults are validated against the current organization catalog and require its revision.',
    parameters: Type.Object({
      agentId: Type.String(),
      expectedRevision: Type.Number(),
      enabledTools: Type.Optional(Type.Array(Type.String())),
      defaultProviderInstallationId: Type.Optional(nullableString),
      defaultProvider: Type.Optional(nullableString),
      defaultModel: Type.Optional(nullableString),
      defaultThinking: Type.Optional(nullableString),
      expectedCatalogRevision: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, params) => {
      const updated = await updateManagedAgentRuntime({ actor: actor(userId, sessionId), ...(params as Omit<Parameters<typeof updateManagedAgentRuntime>[0], 'actor'>) });
      return result(`Updated runtime for ${updated.agentId} to revision ${updated.revision}.`, { agent: updated });
    },
  };

  const updateCapabilities: AgentTool = {
    name: 'update_agent_capabilities',
    label: 'Update agent capabilities',
    description: 'Replaces stable skill/plugin bindings and personal connection requirements after resolving organization policy and readiness. Personal capabilities cannot be embedded in organization agents.',
    parameters: Type.Object({
      agentId: Type.String(),
      expectedRevision: Type.Number(),
      capabilities: Type.Optional(Type.Array(capabilitySelectionSchema)),
      relevantSkills: Type.Optional(Type.Array(Type.String())),
      relevantConnections: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_toolCallId, params) => {
      const updated = await updateManagedAgentCapabilities({ actor: actor(userId, sessionId), ...(params as Omit<Parameters<typeof updateManagedAgentCapabilities>[0], 'actor'>) });
      return result(`Updated capabilities for ${updated.agent.agentId} to revision ${updated.agent.revision}.`, updated);
    },
  };

  const updateFile: AgentTool = {
    name: 'update_agent_file',
    label: 'Update agent file',
    description: 'Writes one agent-managed instruction or memory file with revision protection. Organization definitions are central; organization-agent MEMORY remains user-specific.',
    parameters: Type.Object({
      agentId: Type.String(),
      expectedRevision: Type.Number(),
      fileName: Type.Union([
        Type.Literal('AGENTS.md'),
        Type.Literal('MEMORY.md'),
        Type.Literal('SOUL.md'),
        Type.Literal('TOOLS.md'),
      ]),
      content: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const updated = await updateManagedAgentFile({
        actor: actor(userId, sessionId),
        ...(params as { agentId: string; expectedRevision: number; fileName: AgentManagedFileName; content: string }),
      });
      return result(`Updated ${updated.fileName} for ${updated.agent.agentId} at revision ${updated.agent.revision}.`, updated);
    },
  };

  const inspectWorkflow: AgentTool = {
    name: 'inspect_agent_workflow', label: 'Inspect agent workflow',
    description: 'Returns safe workflow version pins, required capabilities, fixed/selectable modes, current choices and access. Account IDs, credentials and private routing data are never returned.',
    parameters: Type.Object({ agentId: Type.String() }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const data = await inspectManagedAgentWorkflow(actor(userId, sessionId), (params as { agentId: string }).agentId);
      return result(`Workflow for ${data.agentId}, revision ${data.workflowRevision}.`, { workflow: data });
    },
  };
  const workflowOptions: AgentTool = {
    name: 'list_agent_workflow_options', label: 'List agent workflow choices',
    description: 'Lists this actor’s allowed choices for the current centrally configured workflow by default. A fixed connection cannot be changed; selectable choices require the returned workflow and preference revisions. Central editors with canEdit may start with view=management, then request packages, package-version, connections, personal-connections or personal-mcp-definitions using the returned exact agent and workflow revisions. This operation reads metadata only. To inspect accounts, pass a returned personal providerRef and the exact declaration to list_agent_workflow_personal_options outside planning mode. Management results never expose private account IDs, credentials or fingerprints.',
    parameters: Type.Unsafe(z.toJSONSchema(agentWorkflowOptionsToolSchema, { target: 'draft-7', io: 'input' })),
    execute: async (_toolCallId, params) => {
      const input = agentWorkflowOptionsToolSchema.parse(params);
      if (input.view && input.view !== 'options') {
        const data = await listAgentWorkflowManagementOptions(actor(userId, sessionId), input);
        return result(`Workflow configuration options for ${input.agentId}.`, { management: data });
      }
      const data = await listManagedAgentWorkflowOptions(actor(userId, sessionId), input.agentId);
      return result(`Allowed workflow choices for ${data.agentId}.`, { workflow: data });
    },
  };
  const updateConfiguration: AgentTool = {
    name: 'update_agent_configuration', label: 'Update agent configuration',
    description: 'Atomically saves profile, native tools, model defaults and complete extensions with exact package pins, child masks and fixed/selectable standalone MCP/Composio choices. Required capabilities cannot be downgraded. Supply expectedWorkflowRevision when changing extensions or legacy workflow; omitting extensions preserves it, while extensions.mode=legacy_inherit explicitly restores inheritance. Do not combine complete extensions with legacy selection fields. Retain an unchanged saved connection with its returned retainedBindingRef; a fresh personal account needs a current receipt. Instance account choices and permissions belong here, outside portable manifests.',
    parameters: Type.Unsafe(z.toJSONSchema(updateAgentConfigurationSchema, { target: 'draft-7', io: 'input' })),
    execute: async (_toolCallId, params) => {
      const input = updateAgentConfigurationSchema.parse(params);
      const data = await updateManagedAgentConfiguration({ ...input, actor: actor(userId, sessionId) });
      return result(`Updated ${data.agent.agentId} to revision ${data.agent.revision}.`, data);
    },
  };
  const selectWorkflowChoice: AgentTool = {
    name: 'set_agent_workflow_choice', label: 'Select own workflow connection',
    description: 'Saves only the current user’s package or standalone connection choice within the administrator’s allowlist or explicit personal policy. Never changes central configuration, fixed bindings, grants, or tool caps. Use the returned capabilityKey and both current revisions. Provide exactly one choiceId (null clears), personalSelection for a package capability, or standaloneSelection for a standalone slot; a fresh personal Composio account requires its current sealed accountSelectionRef.',
    parameters: Type.Unsafe(z.toJSONSchema(updateAgentWorkflowChoiceSchema, { target: 'draft-7', io: 'input' })),
    execute: async (_toolCallId, params) => {
      const input = updateAgentWorkflowChoiceSchema.parse(params);
      const data = await setManagedAgentWorkflowChoice({ ...bindOwnAgentWorkflowChoiceInput(input, userId), actor: actor(userId, sessionId) });
      return result(`Saved your connection choice for ${data.agentId}.`, { workflow: data });
    },
  };

  const setGrant: AgentTool = {
    name: 'set_agent_grant',
    label: 'Set agent grant',
    description: 'Adds or updates an organization, role, workspace, project, or user grant. Targets are validated against the agent organization and permissions never exceed the caller’s management authority.',
    parameters: Type.Intersect([
      Type.Object({ agentId: Type.String(), expectedRevision: Type.Number() }),
      grantSchema,
    ]),
    execute: async (_toolCallId, params) => {
      const updated = await setManagedAgentGrant({ actor: actor(userId, sessionId), ...(params as Omit<Parameters<typeof setManagedAgentGrant>[0], 'actor'>) });
      return result(`Updated grant for ${updated.agent.agentId} at revision ${updated.agent.revision}.`, updated);
    },
  };

  const removeGrant: AgentTool = {
    name: 'remove_agent_grant',
    label: 'Remove agent grant',
    description: 'Removes one exact organization-agent grant using revision protection.',
    parameters: Type.Object({
      agentId: Type.String(),
      expectedRevision: Type.Number(),
      targetType: grantTargetTypeSchema,
      targetId: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const updated = await removeManagedAgentGrant({ actor: actor(userId, sessionId), ...(params as Omit<Parameters<typeof removeManagedAgentGrant>[0], 'actor'>) });
      return result(`Removed grant from ${updated.agent.agentId} at revision ${updated.agent.revision}.`, updated);
    },
  };

  const previewDeletion: AgentTool = {
    name: 'preview_agent_deletion',
    label: 'Preview agent deletion',
    description: 'Returns the sessions, members, grants, bindings, and managed files affected by deletion plus a short-lived revision-bound confirmation token. It does not delete anything.',
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (_toolCallId, params) => {
      const preview = await previewManagedAgentDeletion(actor(userId, sessionId), (params as { agentId: string }).agentId);
      return result(
        `Deletion preview for ${preview.agent.agentId}: ${preview.impacts.sessions} sessions, ${preview.impacts.grants} grants, ${preview.impacts.capabilityBindings} capability bindings.`,
        preview,
      );
    },
  };

  const deleteAgent: AgentTool = {
    name: 'delete_agent',
    label: 'Delete agent',
    description: 'Deletes a removable agent only after preview_agent_deletion supplied a matching unexpired confirmation token. Bradley is always protected.',
    parameters: Type.Object({
      agentId: Type.String(),
      expectedRevision: Type.Number(),
      confirmationToken: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const deleted = await deleteManagedAgent({ actor: actor(userId, sessionId), ...(params as Omit<Parameters<typeof deleteManagedAgent>[0], 'actor'>) });
      return result(`Deleted agent ${deleted.agentId}.`, deleted);
    },
  };

  return [
    listAgents,
    inspectAgent,
    protectWorkflowTool(inspectWorkflow),
    protectWorkflowTool(workflowOptions),
    protectWorkflowTool(personalWorkflowOptions),
    protectWorkflowTool(createAgent),
    updateProfile,
    updateRuntime,
    updateCapabilities,
    protectWorkflowTool(updateConfiguration),
    protectWorkflowTool(selectWorkflowChoice),
    updateFile,
    setGrant,
    removeGrant,
    previewDeletion,
    deleteAgent,
  ];
}
