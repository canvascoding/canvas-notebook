export type TodoEffectiveReadState = {
  readAt: Date | null;
  readState: 'read' | 'unread';
};

type TodoReadStateLifecycle = {
  status: string;
  persistedReadAt: Date | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  updatedAt: Date;
};

/**
 * Read state is personal while a To-do is open. Terminal lifecycle states are
 * always read: a missing per-user row must never turn a completed shared
 * To-do into a new attention item for another viewer.
 */
export function deriveTodoEffectiveReadState(input: TodoReadStateLifecycle): TodoEffectiveReadState {
  if (input.status === 'open') {
    return input.persistedReadAt
      ? { readAt: input.persistedReadAt, readState: 'read' }
      : { readAt: null, readState: 'unread' };
  }

  return {
    readAt: input.persistedReadAt ?? input.completedAt ?? input.archivedAt ?? input.updatedAt,
    readState: 'read',
  };
}

export function todoLifecycleAllowsUnread(status: string): boolean {
  return status === 'open';
}
