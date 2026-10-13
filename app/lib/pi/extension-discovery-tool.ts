import 'server-only';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { z } from 'zod';
import { getAgentExecutionContext } from './agent-execution-context';
import { RUNTIME_EXTENSION_SEARCH_OPERATION, runtimeExtensionSearchInputSchema } from '@/app/lib/capabilities/extensions/discovery-contracts';
import { searchRuntimeExtensions } from '@/app/lib/capabilities/extensions/runtime-discovery';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';

export function createExtensionDiscoveryTool(userId?: string, agentId?: string | null, sessionId?: string | null): AgentTool {
  return {
    name: RUNTIME_EXTENSION_SEARCH_OPERATION,
    label: 'Find permitted skills and plugins',
    description: 'Search currently permitted installed skill/plugin metadata by the task, name or description. Returns exact sources and authorized SKILL.md locations within this agent selection. These are metadata, not executable read recipes: use a permitted registered read route before following a skill; without that route skill reading is unavailable. This read-only search never installs, enables, authorizes or probes an external account; it is safe in planning mode.',
    parameters: Type.Unsafe(z.toJSONSchema(runtimeExtensionSearchInputSchema, { target: 'draft-7', io: 'input' })),
    execute: async (_toolCallId, value) => {
      const context = getAgentExecutionContext();
      if (!userId || !context || context.userId !== userId || !context.sessionId || !context.workspaceId
        || agentId && context.agentId !== agentId || sessionId && context.sessionId !== sessionId) {
        throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A current matching agent session is required.', 403);
      }
      const result = await searchRuntimeExtensions(context, value);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { extensionDiscovery: result } };
    },
  };
}
