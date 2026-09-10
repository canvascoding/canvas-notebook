import type { TodoWithRelations } from '@/app/lib/todos/store';
import { isToolAppRecord } from './types';

export type TodoAppData = {
  id: string;
  title: string;
  status: 'open' | 'done' | 'archived';
  priority: 'low' | 'normal' | 'high';
  category: string | null;
  assignee: string | null;
  dueAt: string | null;
  updatedAt: string;
};

/** Descriptions, file paths, email addresses and provenance stay in the Todo editor. */
export function presentTodoAppData(todo: TodoWithRelations): TodoAppData {
  const data = readTodoAppData({ id: todo.id, title: todo.title, status: todo.status, priority: todo.priority,
    category: todo.category?.name?.slice(0, 120) || null, assignee: todo.assignee?.name?.slice(0, 160) || null,
    dueAt: todo.dueAt?.toISOString() ?? null, updatedAt: todo.updatedAt.toISOString() });
  if (!data) throw new Error('Todo widget data is unavailable.');
  return data;
}

export function readTodoAppData(value: unknown): TodoAppData | null {
  if (!isToolAppRecord(value) || typeof value.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.id)
    || typeof value.title !== 'string' || value.title.length > 500
    || !['open', 'done', 'archived'].includes(String(value.status))
    || !['low', 'normal', 'high'].includes(String(value.priority))
    || (value.category !== null && (typeof value.category !== 'string' || value.category.length > 120))
    || (value.assignee !== null && (typeof value.assignee !== 'string' || value.assignee.length > 160))
    || (value.dueAt !== null && (typeof value.dueAt !== 'string' || !Number.isFinite(Date.parse(value.dueAt))))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  return { id: value.id, title: value.title, status: value.status as TodoAppData['status'], priority: value.priority as TodoAppData['priority'],
    category: value.category as string | null, assignee: value.assignee as string | null, dueAt: value.dueAt as string | null, updatedAt: value.updatedAt };
}
