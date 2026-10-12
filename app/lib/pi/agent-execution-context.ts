import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkspaceType } from '@/app/lib/workspaces/types';
import type { HeldCapabilityPackageRuntimeBinding } from '@/app/lib/capabilities/packages/runtime-bindings';

export type AgentExecutionContext = {
  userId: string;
  sessionId: string;
  /** Server-issued identity for the user message currently driving this tool call. */
  agentTurnId?: string;
  agentId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceName: string | null;
  workspaceDescription?: string | null;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceRoot: string;
  workspaceRootRelativePath: string | null;
  skillReadRoots?: readonly string[];
  /** Private server-issued package receipts; serialized clones cannot authorize roots. */
  skillPackageBindings?: readonly HeldCapabilityPackageRuntimeBinding[];
  canWrite: boolean;
  canDelete: boolean;
  canShare: boolean;
  legacy: boolean;
  brandContext?: string;
};

const agentExecutionContextStorage = new AsyncLocalStorage<AgentExecutionContext>();

export function getAgentExecutionContext(): AgentExecutionContext | null {
  return agentExecutionContextStorage.getStore() ?? null;
}

export function runWithAgentExecutionContext<T>(
  context: AgentExecutionContext,
  callback: () => T,
): T {
  return agentExecutionContextStorage.run(context, callback);
}
