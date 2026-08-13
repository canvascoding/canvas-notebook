import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const TODO_SCOPE_KINDS = ['user', 'workspace'] as const;
export type TodoScopeKind = typeof TODO_SCOPE_KINDS[number];

export type TodoWorkspaceScopeInput = {
  scopeKind: 'workspace';
  workspaceType: WorkspaceContext['workspaceType'];
  organizationId: string | null;
  workspaceId: string;
};

type TodoWorkspaceContext = Pick<WorkspaceContext, 'workspaceId' | 'workspaceType' | 'organizationId'>;

export const USER_TODO_SCOPE = {
  scopeKind: 'user',
  workspaceType: 'personal',
} as const;

export function todoScopeForWorkspace(workspace: TodoWorkspaceContext): TodoWorkspaceScopeInput {
  return {
    scopeKind: 'workspace',
    workspaceType: workspace.workspaceType,
    organizationId: workspace.organizationId ?? null,
    workspaceId: workspace.workspaceId,
  };
}

export function parseTodoScopeKind(value: unknown): TodoScopeKind | null {
  return value === 'user' || value === 'workspace' ? value : null;
}
