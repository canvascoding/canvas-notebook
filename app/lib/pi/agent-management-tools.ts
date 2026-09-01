import 'server-only';

import { type AgentTool, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import {
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
    description: 'Inspects one available agent. Profile, runtime, capability bindings, readiness, and access are returned by default; managed-file contents and grants require matching edit/manage access.',
    parameters: Type.Object({
      agentId: Type.String(),
      includeFiles: Type.Optional(Type.Boolean()),
      includeAccess: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { agentId: string; includeFiles?: boolean; includeAccess?: boolean };
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
    description: 'Creates a complete personal or organization agent with profile, runtime defaults, tools, stable skill/plugin bindings, connection requirements, managed instruction files, and optional organization grants. Organization agents require owner/admin permission.',
    parameters: Type.Object({
      name: Type.String(),
      agentId: Type.Optional(Type.String()),
      iconId: Type.Optional(Type.String()),
      scopeType: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('organization')])),
      defaultProviderInstallationId: Type.Optional(nullableString),
      defaultProvider: Type.Optional(nullableString),
      defaultModel: Type.Optional(nullableString),
      defaultThinking: Type.Optional(nullableString),
      expectedCatalogRevision: Type.Optional(Type.Number()),
      enabledTools: Type.Optional(Type.Array(Type.String())),
      relevantSkills: Type.Optional(Type.Array(Type.String())),
      relevantConnections: Type.Optional(Type.Array(Type.String())),
      capabilities: Type.Optional(Type.Array(capabilitySelectionSchema)),
      files: Type.Optional(Type.Partial(Type.Object({
        'AGENTS.md': Type.String(),
        'MEMORY.md': Type.String(),
        'SOUL.md': Type.String(),
        'TOOLS.md': Type.String(),
      }))),
      grants: Type.Optional(Type.Array(grantSchema)),
    }),
    execute: async (_toolCallId, params) => {
      const created = await createManagedAgent(actor(userId, sessionId), params as Parameters<typeof createManagedAgent>[1]);
      return result(
        `Created ${created.agent.scopeType} agent ${created.agent.name} (${created.agent.agentId}) at revision ${created.agent.revision}.`,
        created,
      );
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
    createAgent,
    updateProfile,
    updateRuntime,
    updateCapabilities,
    updateFile,
    setGrant,
    removeGrant,
    previewDeletion,
    deleteAgent,
  ];
}
