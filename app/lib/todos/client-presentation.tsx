import { CalendarDays, Check, CheckCircle2, Eye, FileText, Lightbulb, MailWarning, MessageSquare, Settings2, UserRound } from 'lucide-react';
import type { TodoFormState, TodoIconKey, TodoItem, TodoPriority, TodoUserSummary } from './client-types';

export const todoIconKeys: TodoIconKey[] = ['check', 'eye', 'approval', 'message', 'file', 'calendar', 'warning', 'idea', 'user', 'settings'];

export function TodoIcon({ iconKey, className = 'h-4 w-4' }: { iconKey: TodoIconKey | null; className?: string }) {
  if (iconKey === 'eye') return <Eye className={className} />;
  if (iconKey === 'approval') return <CheckCircle2 className={className} />;
  if (iconKey === 'message') return <MessageSquare className={className} />;
  if (iconKey === 'file') return <FileText className={className} />;
  if (iconKey === 'calendar') return <CalendarDays className={className} />;
  if (iconKey === 'warning') return <MailWarning className={className} />;
  if (iconKey === 'idea') return <Lightbulb className={className} />;
  if (iconKey === 'user') return <UserRound className={className} />;
  if (iconKey === 'settings') return <Settings2 className={className} />;
  return <Check className={className} />;
}

export function resolvedTodoIconKey(todo: Pick<TodoItem, 'iconKey' | 'category'>): TodoIconKey {
  if (todo.iconKey) return todo.iconKey;
  if (todo.category?.icon === 'search-check') return 'eye';
  if (todo.category?.icon === 'badge-check') return 'approval';
  if (todo.category?.icon === 'workflow') return 'settings';
  return 'check';
}

export const emptyForm: TodoFormState = {
  title: '',
  description: '',
  categoryId: '',
  priority: 'normal',
  iconKey: '',
  dueAt: '',
  remindAt: '',
  assigneeUserId: '',
  fileLinks: [],
};

function toDateInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function formatDate(value: string | null, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export function isOverdue(todo: TodoItem) {
  if (!todo.dueAt || todo.status !== 'open') return false;
  const due = new Date(todo.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

export function todoToForm(todo: TodoItem): TodoFormState {
  return {
    title: todo.title,
    description: todo.description ?? '',
    categoryId: todo.category?.id ?? '',
    priority: todo.priority,
    iconKey: todo.iconKey ?? '',
    dueAt: toDateInput(todo.dueAt),
    remindAt: toLocalDateTimeInput(todo.remindAt),
    assigneeUserId: todo.assigneeUserId ?? '',
    fileLinks: todo.fileLinks.map((link) => ({
      workspacePath: link.workspacePath,
      label: link.label,
    })),
  };
}

export function formatTodoUser(user: TodoUserSummary | null | undefined, fallback: string) {
  return user?.name || user?.email || user?.id || fallback;
}


export const priorities: TodoPriority[] = ['low', 'normal', 'high'];

export function toLocalDateTimeInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function formatDateTime(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

// Omit untouched fields on updates. This preserves timestamp precision, avoids
// resending reminders, and retains categories/assignees that are no longer
// selectable but still belong to the existing to-do.
export function todoFormPayload(form: TodoFormState, originalTodo?: TodoItem | null) {
  const payload = {
    title: form.title.trim(),
    description: form.description || null,
    categoryId: form.categoryId || null,
    priority: form.priority,
    iconKey: form.iconKey || null,
    dueAt: form.dueAt || null,
    remindAt: form.remindAt ? new Date(form.remindAt).toISOString() : null,
    assigneeUserId: form.assigneeUserId || null,
    fileLinks: form.fileLinks,
  };
  if (!originalTodo) return payload;
  const originalForm = todoToForm(originalTodo);
  const updates: Partial<typeof payload> = { ...payload };
  for (const key of Object.keys(form) as Array<keyof TodoFormState>) {
    if (JSON.stringify(form[key]) === JSON.stringify(originalForm[key])) delete updates[key];
  }
  return updates;
}
