'use client';

import type { AssigneeOption, TodoCategory, TodoItem } from './client-types';

export class TodoClientError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
    this.name = 'TodoClientError';
  }
}

async function readTodoResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success || body.data === undefined) {
    throw new TodoClientError(body?.error || 'Unable to load or save this to-do.', response.status, body?.code || null);
  }
  return body.data as T;
}

export async function loadTodoDetail(id: string, signal?: AbortSignal): Promise<TodoItem> {
  return readTodoResponse(await fetch(`/api/todos/${encodeURIComponent(id)}`, {
    credentials: 'include', cache: 'no-store', signal,
  }));
}

export async function patchTodoDetail(todo: TodoItem, payload: Record<string, unknown>): Promise<TodoItem> {
  return readTodoResponse(await fetch(`/api/todos/${encodeURIComponent(todo.id)}`, {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt: todo.updatedAt, ...payload }),
  }));
}

export async function loadTodoEditorOptions(todo: TodoItem, signal?: AbortSignal, viewer?: AssigneeOption) {
  const categories = fetch('/api/todo-categories', {
    credentials: 'include', cache: 'no-store', signal,
  }).then(readTodoResponse<TodoCategory[]>);
  // A personal to-do is scoped to its owner, regardless of the active workspace.
  const assignees = todo.scopeKind === 'user'
    ? Promise.resolve<AssigneeOption[]>(viewer ? [viewer] : todo.createdBy ? [todo.createdBy] : [])
    : fetch(`/api/todos/assignees?${new URLSearchParams({ workspaceId: todo.workspaceId || '' })}`, {
      credentials: 'include', cache: 'no-store', signal,
    }).then(readTodoResponse<AssigneeOption[]>);
  const [categoryList, assigneeList] = await Promise.all([categories, assignees]);
  if (todo.category && !categoryList.some((category) => category.id === todo.category!.id)) categoryList.push(todo.category);
  if (todo.assignee && !assigneeList.some((candidate) => candidate.id === todo.assignee!.id)) assigneeList.push(todo.assignee);
  return { categories: categoryList, assignees: assigneeList };
}

export async function sendTodoDetailFollowUp(todo: TodoItem, comment: string, locale: string): Promise<TodoItem> {
  const data = await readTodoResponse<{ todo: TodoItem }>(await fetch(`/api/todos/${encodeURIComponent(todo.id)}/follow-up`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment, locale }),
  }));
  return { ...data.todo, canWrite: todo.canWrite };
}
