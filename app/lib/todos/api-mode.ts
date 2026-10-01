/** Read metadata is a compatibility contract for older installed clients only. */
export type TodoApiMode = 'legacy' | 'lifecycle';

export const TODO_LIFECYCLE_CAPABILITY = 'todos.lifecycle' as const;

export class TodoApiModeError extends Error {
  readonly code = 'TODO_READ_STATE_NOT_SUPPORTED';
  readonly status = 400;

  constructor() {
    super('To-dos are tracked by completion status. Read state is not supported in lifecycle mode.');
    this.name = 'TodoApiModeError';
  }
}

export function requestedTodoApiMode(searchParams: Pick<URLSearchParams, 'get'>): TodoApiMode {
  return searchParams.get('todoMode') === 'lifecycle' ? 'lifecycle' : 'legacy';
}

export function assertTodoReadActionSupported(mode: TodoApiMode, payload: Record<string, unknown>): void {
  if (mode === 'lifecycle' && ['read', 'readState', 'readAt', 'seenAt', 'markSeen'].some((key) => payload[key] !== undefined)) {
    throw new TodoApiModeError();
  }
}

export function todoForApi<T extends { seenAt?: unknown; readAt?: unknown; readState?: unknown }>(todo: T, mode: TodoApiMode): T | Omit<T, 'seenAt' | 'readAt' | 'readState'> {
  if (mode === 'legacy') return todo;
  const { seenAt: _seenAt, readAt: _readAt, readState: _readState, ...lifecycleTodo } = todo;
  return lifecycleTodo;
}
