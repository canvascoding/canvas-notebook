import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import type { WorkspaceType } from '@/app/lib/workspaces/types';

export type AgentExecutionContext = {
  userId: string;
  sessionId: string;
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceName: string | null;
  organizationId: string | null;
  workspaceRoot: string;
  workspaceRootRelativePath: string | null;
  canWrite: boolean;
  canShare: boolean;
  legacy: boolean;
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
