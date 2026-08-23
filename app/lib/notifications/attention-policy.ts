import type { TodoWithRelations } from '@/app/lib/todos/store';

export const TODO_ATTENTION_REASONS = [
  'overdue',
  'due_today',
  'high_priority',
  'unread',
  'due_soon',
] as const;

export type TodoAttentionReason = typeof TODO_ATTENTION_REASONS[number];

export type TodoAttentionCandidate = TodoWithRelations & {
  attentionReason: TodoAttentionReason;
};

function startOfTomorrow(now: Date): Date {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow;
}

function endOfAttentionWindow(now: Date): Date {
  const end = startOfTomorrow(now);
  end.setDate(end.getDate() + 6);
  return end;
}

function attentionReason(todo: TodoWithRelations, viewerUserId: string, now: Date): TodoAttentionReason | null {
  if (todo.status !== 'open') return null;
  const isPersonal = todo.workspaceType === 'personal' && todo.userId === viewerUserId;
  const isAssigned = todo.assigneeUserId === viewerUserId;
  const isUnassignedCreator = todo.assigneeUserId === null && todo.createdByUserId === viewerUserId;
  if (!isPersonal && !isAssigned && !isUnassignedCreator) return null;

  const dueAt = todo.dueAt;
  if (dueAt && dueAt < now) return 'overdue';
  if (dueAt && dueAt < startOfTomorrow(now)) return 'due_today';
  if (todo.priority === 'high') return 'high_priority';
  if (todo.readState === 'unread') return 'unread';
  if (dueAt && dueAt <= endOfAttentionWindow(now)) return 'due_soon';
  return null;
}

const reasonRank: Record<TodoAttentionReason, number> = {
  overdue: 0,
  due_today: 1,
  high_priority: 2,
  unread: 3,
  due_soon: 4,
};

function compareCandidates(viewerUserId: string, left: TodoAttentionCandidate, right: TodoAttentionCandidate): number {
  const leftAssignedRank = left.assigneeUserId === viewerUserId ? 0 : 1;
  const rightAssignedRank = right.assigneeUserId === viewerUserId ? 0 : 1;
  return reasonRank[left.attentionReason] - reasonRank[right.attentionReason]
    || leftAssignedRank - rightAssignedRank
    || (left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    || right.updatedAt.getTime() - left.updatedAt.getTime()
    || right.id.localeCompare(left.id);
}

export function selectTodoAttention(input: {
  todos: TodoWithRelations[];
  viewerUserId: string;
  now: Date;
  limit?: number;
}): TodoAttentionCandidate[] {
  const candidates = input.todos.flatMap((todo) => {
    const reason = attentionReason(todo, input.viewerUserId, input.now);
    return reason ? [{ ...todo, attentionReason: reason }] : [];
  });
  return candidates
    .sort((left, right) => compareCandidates(input.viewerUserId, left, right))
    .slice(0, input.limit ?? 6);
}
