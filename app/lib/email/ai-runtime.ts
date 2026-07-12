import 'server-only';

import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

import {
  resolveExecutableAgentRuntime,
  type ExecutableAgentRuntime,
} from '@/app/lib/agent-runtime-policy/provider-runtime';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type EmailAiScope = {
  userId: string;
  workspaceId?: string | null;
};

export type ScopedEmailAiRuntime = {
  model: ExecutableAgentRuntime['model'];
  selection: ExecutableAgentRuntime['selection'];
  streamFn: ExecutableAgentRuntime['streamFn'];
  thinkingLevel: ModelThinkingLevel;
  workspace: WorkspaceContext;
};

function assertSameEmailWorkspace(expected: WorkspaceContext, actual: WorkspaceContext): void {
  if (
    expected.workspaceId !== actual.workspaceId
    || expected.workspaceType !== actual.workspaceType
    || expected.organizationId !== actual.organizationId
    || expected.customerId !== actual.customerId
    || expected.projectId !== actual.projectId
    || expected.rootPath !== actual.rootPath
  ) {
    throw new Error('Email AI workspace changed while the request was running.');
  }
}

export async function reauthorizeEmailAiWorkspace(input: {
  userId: string;
  workspace: WorkspaceContext;
}): Promise<WorkspaceContext> {
  const authorizedWorkspace = await resolveAgentSessionWorkspaceForUser({
    userId: input.userId,
    workspaceId: input.workspace.workspaceId,
  });
  assertSameEmailWorkspace(input.workspace, authorizedWorkspace);
  return authorizedWorkspace;
}

export async function resolveScopedEmailAiRuntime(scope: EmailAiScope): Promise<ScopedEmailAiRuntime> {
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: scope.userId,
    workspaceId: scope.workspaceId,
  });
  if (!workspace.organizationId) {
    throw new Error('Complete the app AI runtime setup before using Email AI.');
  }

  const runtimeContext = {
    organizationId: workspace.organizationId,
    userId: scope.userId,
    workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType,
    agentId: DEFAULT_AGENT_ID,
    sessionId: null,
  };
  const inheritedRuntime = await resolveExecutableAgentRuntime({
    ...runtimeContext,
    requestedSelection: null,
  });
  // Freeze the inherited user/default choice for this one email run. Later
  // provider calls still revalidate catalog, policy, credentials and workspace
  // access, but a concurrent preference change cannot switch models mid-run.
  const executable = await resolveExecutableAgentRuntime({
    ...runtimeContext,
    requestedSelection: inheritedRuntime.selection.selection,
  });

  const streamFn: ExecutableAgentRuntime['streamFn'] = async (model, context, options) => {
    await reauthorizeEmailAiWorkspace({ userId: scope.userId, workspace });
    return executable.streamFn(model, context, options);
  };

  return {
    model: executable.model,
    selection: executable.selection,
    streamFn,
    thinkingLevel: executable.selection.selection.thinkingLevel,
    workspace,
  };
}
