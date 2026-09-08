export type TodoIdentity = {
  id: string;
};

export function resolveTodoById<Todo extends TodoIdentity>(
  todos: readonly Todo[],
  todoId: string | null | undefined,
  fallbackTodo: Todo | null = null,
): Todo | null {
  if (!todoId) return null;

  const todo = todos.find((item) => item.id === todoId);
  if (todo) return todo;

  return fallbackTodo?.id === todoId ? fallbackTodo : null;
}
