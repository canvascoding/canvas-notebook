import { clearTodoReadState, setTodoReadState } from './read-state-store';
import { todoLifecycleAllowsUnread } from './read-state-policy';
import { getTodo, TodoStoreError, type TodoWithRelations } from './store';

export type TodoReadStateActionResult = {
  todo: TodoWithRelations;
  read: boolean;
  readAt: Date | null;
};

/**
 * Changes only the current user's presentation state. Reading a shared To-do
 * therefore needs read access, but never changes the shared Todo updatedAt.
 */
export async function setTodoReadStateForUser(input: {
  userId: string;
  todoId: string;
  read: boolean;
  readAt?: Date;
}): Promise<TodoReadStateActionResult> {
  const todo = await getTodo(input.userId, input.todoId);
  if (!todo) {
    throw new TodoStoreError('Todo not found.', 'TODO_NOT_FOUND');
  }

  if (!input.read && !todoLifecycleAllowsUnread(todo.status)) {
    throw new TodoStoreError('Completed or archived to-dos cannot be marked unread.', 'TODO_READ_STATE_CONFLICT');
  }

  const readAt = input.read
    ? await setTodoReadState(input.userId, input.todoId, input.readAt ?? new Date())
    : null;
  if (!input.read) {
    await clearTodoReadState(input.userId, input.todoId);
  }

  const updatedTodo = await getTodo(input.userId, input.todoId);
  if (!updatedTodo) {
    throw new TodoStoreError('Todo not found.', 'TODO_NOT_FOUND');
  }

  return { todo: updatedTodo, read: input.read, readAt };
}
