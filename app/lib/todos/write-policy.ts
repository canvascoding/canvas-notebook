import 'server-only';

import { requireSessionWorkspace, type RequestWorkspaceSession } from '@/app/lib/workspaces/request';
import { canWriteTodo, TodoStoreError, type TodoItem } from './store';

/** Per-request cache only: permissions are always resolved again for a mutation. */
export function createTodoWritePolicy(session: RequestWorkspaceSession) {
  const permissions = new Map<string, Promise<boolean>>();
  const canWrite = (todo: TodoItem): Promise<boolean> => {
    const key = JSON.stringify([todo.userId, todo.workspaceType, todo.workspaceId, todo.organizationId]);
    let pending = permissions.get(key);
    if (!pending) {
      pending = (async () => {
        if (!await canWriteTodo(session.user.id, todo)) return false;
        if (todo.workspaceId) {
          const result = await requireSessionWorkspace(session, { workspaceId: todo.workspaceId, permissions: 'canWrite' });
          if (result.response) return false;
        }
        return true;
      })();
      permissions.set(key, pending);
    }
    return pending;
  };
  return {
    canWrite,
    async authorize(todo: TodoItem) {
      if (!await canWrite(todo)) throw new TodoStoreError('You cannot edit one or more selected to-dos.', 'ORGANIZATION_ACCESS_DENIED');
    },
  };
}
