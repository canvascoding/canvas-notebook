import type { TodoPriority, TodoStatus } from './store';

export const TODO_BULK_LIMIT = 1000;

export type TodoBulkAction =
  | { type: 'complete' | 'reopen' | 'archive' | 'restore' }
  | { type: 'category'; categoryId: string | null }
  | { type: 'priority'; priority: TodoPriority }
  | { type: 'assign'; assigneeUserId: string | null };

export type TodoBulkSelectionItem = {
  id: string;
  updatedAt: string;
  status: TodoStatus;
  canWrite: boolean;
};

export class TodoBulkError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_BULK_INPUT' | 'TODO_SELECTION_LIMIT' | 'TODO_BULK_CONFLICT' | 'TODO_BULK_STATUS',
    public readonly ids: string[] = [],
  ) {
    super(message);
    this.name = 'TodoBulkError';
  }
}

export function bulkActionAllowsStatus(type: TodoBulkAction['type'], status: TodoStatus): boolean {
  return type === 'restore' ? status === 'archived' : status !== 'archived';
}

export function parseTodoBulkInput(value: unknown): {
  items: Array<{ id: string; expectedUpdatedAt: Date }>;
  action: TodoBulkAction;
} {
  const invalid = () => new TodoBulkError('Invalid bulk action or selection.', 'INVALID_BULK_INPUT');
  if (!value || typeof value !== 'object') throw invalid();
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > TODO_BULK_LIMIT) throw invalid();
  const items = new Map<string, { id: string; expectedUpdatedAt: Date }>();
  for (const item of input.items) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 160
      || typeof item.expectedUpdatedAt !== 'string') throw invalid();
    const expectedUpdatedAt = new Date(item.expectedUpdatedAt);
    if (Number.isNaN(expectedUpdatedAt.getTime())) throw invalid();
    const previous = items.get(item.id);
    if (previous && previous.expectedUpdatedAt.getTime() !== expectedUpdatedAt.getTime()) throw invalid();
    items.set(item.id, { id: item.id, expectedUpdatedAt });
  }
  if (!input.action || typeof input.action !== 'object') throw invalid();
  const action = input.action as Record<string, unknown>;
  const nullableId = (id: unknown) => id === null || (typeof id === 'string' && Boolean(id.trim()) && id.length <= 160);
  switch (action.type) {
    case 'complete': case 'reopen': case 'archive': case 'restore':
      return { items: [...items.values()], action: { type: action.type } };
    case 'category':
      if (!nullableId(action.categoryId)) throw invalid();
      return { items: [...items.values()], action: { type: 'category', categoryId: action.categoryId as string | null } };
    case 'priority':
      if (!['low', 'normal', 'high'].includes(String(action.priority))) throw invalid();
      return { items: [...items.values()], action: { type: 'priority', priority: action.priority as TodoPriority } };
    case 'assign':
      if (!nullableId(action.assigneeUserId)) throw invalid();
      return { items: [...items.values()], action: { type: 'assign', assigneeUserId: action.assigneeUserId as string | null } };
    default: throw invalid();
  }
}
