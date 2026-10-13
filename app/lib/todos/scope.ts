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

export function todoMatchesWorkspaceScope(todo: {
  scopeKind: string;
  workspaceType: string;
  workspaceId: string | null;
  organizationId: string | null;
}, workspace: TodoWorkspaceContext): boolean {
  if (todo.workspaceType !== workspace.workspaceType) return false;
  if (todo.scopeKind === 'user') return todo.workspaceType === 'personal';
  if (todo.scopeKind !== 'workspace' || todo.workspaceId !== workspace.workspaceId) return false;
  return todo.workspaceType === 'personal'
    || (todo.organizationId ?? null) === (workspace.organizationId ?? null);
}

export function parseTodoScopeKind(value: unknown): TodoScopeKind | null {
  return value === 'user' || value === 'workspace' ? value : null;
}
