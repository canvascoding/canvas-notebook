'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Archive,
  BellOff,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Edit3,
  ExternalLink,
  FileText,
  FolderSearch,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react';

import { Link } from '@/i18n/navigation';
import { getDefaultTodoCategoryKey } from '@/app/lib/todos/default-categories';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type TodoStatus = 'open' | 'done' | 'archived';
type TodoPriority = 'low' | 'normal' | 'high';
type TodoSourceType = 'user' | 'agent';
type StatusFilter = 'active' | TodoStatus | 'all';

type TodoCategory = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  isArchived: boolean;
  sortOrder: number;
};

type TodoFileLink = {
  id: string;
  workspacePath: string;
  label: string | null;
};

type TodoItem = {
  id: string;
  title: string;
  description: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  sourceType: TodoSourceType;
  sourceSessionId: string | null;
  dueAt: string | null;
  seenAt: string | null;
  completedAt: string | null;
  completionComment: string | null;
  followUpSentAt: string | null;
  followUpError: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  category: TodoCategory | null;
  fileLinks: TodoFileLink[];
};

type WorkspaceFileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type TodoFollowUpResponse = {
  todo: TodoItem;
  sessionId: string;
};

type TodoFormState = {
  title: string;
  description: string;
  categoryId: string;
  priority: TodoPriority;
  dueAt: string;
  fileLinks: Array<{ workspacePath: string; label: string | null }>;
};

const statusFilters: StatusFilter[] = ['active', 'open', 'done', 'archived', 'all'];
const priorities: TodoPriority[] = ['low', 'normal', 'high'];

const emptyForm: TodoFormState = {
  title: '',
  description: '',
  categoryId: '',
  priority: 'normal',
  dueAt: '',
  fileLinks: [],
};

async function readApiData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
  if (!response.ok || !payload?.success || payload.data === undefined) {
    throw new Error(payload?.error || 'Request failed');
  }
  return payload.data;
}

function toDateInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string | null, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

function isOverdue(todo: TodoItem) {
  if (!todo.dueAt || todo.status !== 'open') return false;
  const due = new Date(todo.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

function todoToForm(todo: TodoItem): TodoFormState {
  return {
    title: todo.title,
    description: todo.description ?? '',
    categoryId: todo.category?.id ?? '',
    priority: todo.priority,
    dueAt: toDateInput(todo.dueAt),
    fileLinks: todo.fileLinks.map((link) => ({
      workspacePath: link.workspacePath,
      label: link.label,
    })),
  };
}

function fileLinkHref(workspacePath: string) {
  return `/files?path=${encodeURIComponent(workspacePath)}`;
}

function pushTodoChatState(todo: Pick<TodoItem, 'id' | 'sourceSessionId'>) {
  if (!todo.sourceSessionId || typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  url.searchParams.set('todo', todo.id);
  url.searchParams.set('session', todo.sourceSessionId);
  url.searchParams.set('chat', 'open');

  const nextPath = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextPath !== currentPath) {
    window.history.pushState({ todoId: todo.id, sessionId: todo.sourceSessionId }, '', nextPath);
  }
}

function openDockChatSession(sessionId: string | null) {
  if (!sessionId || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('canvas:open-chat-session', {
    detail: { sessionId },
  }));
}

export function TodosClient({ title }: { title: string }) {
  const t = useTranslations('todos');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const openedTodoParamRef = useRef<string | null>(null);
  const pendingTodoParamRef = useRef<string | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [categories, setCategories] = useState<TodoCategory[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [form, setForm] = useState<TodoFormState>(emptyForm);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<TodoCategory | null>(null);
  const [categoryDraft, setCategoryDraft] = useState({ name: '', color: '#3b82f6' });
  const [fileQuery, setFileQuery] = useState('');
  const [fileResults, setFileResults] = useState<WorkspaceFileEntry[]>([]);
  const [isFileSearching, setIsFileSearching] = useState(false);
  const [followUpDraft, setFollowUpDraft] = useState<{ todoId: string | null; value: string }>({ todoId: null, value: '' });
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);

  const selectedTodo = useMemo(
    () => todos.find((todo) => todo.id === selectedTodoId) ?? null,
    [selectedTodoId, todos],
  );

  const followUpComment = selectedTodo && followUpDraft.todoId === selectedTodo.id
    ? followUpDraft.value
    : selectedTodo?.completionComment ?? '';

  const updateFollowUpComment = useCallback((value: string) => {
    if (!selectedTodo) return;
    setFollowUpDraft({ todoId: selectedTodo.id, value });
  }, [selectedTodo]);

  const openTodoSession = useCallback((todo: Pick<TodoItem, 'id' | 'sourceSessionId'>) => {
    openDockChatSession(todo.sourceSessionId);
    pushTodoChatState(todo);
  }, []);

  const visibleUnreadCount = useMemo(
    () => todos.filter((todo) => todo.status !== 'archived' && !todo.seenAt).length,
    [todos],
  );

  const openCount = useMemo(() => todos.filter((todo) => todo.status === 'open').length, [todos]);
  const doneCount = useMemo(() => todos.filter((todo) => todo.status === 'done').length, [todos]);

  const formatCategoryName = useCallback((category: Pick<TodoCategory, 'name' | 'icon'> | null | undefined) => {
    if (!category) return t('filters.noCategory');
    const defaultKey = getDefaultTodoCategoryKey(category);
    return defaultKey ? t(`defaultCategories.${defaultKey}`) : category.name;
  }, [t]);

  const selectedCategoryName = useMemo(() => {
    if (!categoryFilter) return t('filters.allCategories');
    const category = categories.find((item) => item.id === categoryFilter);
    return category ? formatCategoryName(category) : t('filters.allCategories');
  }, [categories, categoryFilter, formatCategoryName, t]);

  const filterSummary = useMemo(
    () => `${t(`filters.status.${statusFilter}`)} · ${selectedCategoryName}`,
    [selectedCategoryName, statusFilter, t],
  );

  const loadCategories = useCallback(async () => {
    const response = await fetch('/api/todo-categories', { credentials: 'include', cache: 'no-store' });
    const data = await readApiData<TodoCategory[]>(response);
    setCategories(data);
    return data;
  }, []);

  const loadTodos = useCallback(async () => {
    const params = new URLSearchParams({ status: statusFilter });
    if (categoryFilter) params.set('categoryId', categoryFilter);
    const response = await fetch(`/api/todos?${params.toString()}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const data = await readApiData<TodoItem[]>(response);
    setTodos(data);
    setSelectedTodoId((current) => (current && data.some((todo) => todo.id === current) ? current : null));
    return data;
  }, [categoryFilter, statusFilter]);

  const refreshAll = useCallback(async () => {
    setIsLoading(true);
    try {
      await Promise.all([loadCategories(), loadTodos()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [loadCategories, loadTodos, t]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        await Promise.all([loadCategories(), loadTodos()]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [loadCategories, loadTodos, t]);

  useEffect(() => {
    if (!editorOpen) return;

    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      setIsFileSearching(true);
      try {
        const response = await fetch(`/api/files/list?q=${encodeURIComponent(fileQuery)}&limit=20`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await response.json() as { success?: boolean; files?: WorkspaceFileEntry[] };
        setFileResults(payload.success ? (payload.files ?? []) : []);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setFileResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsFileSearching(false);
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [editorOpen, fileQuery]);

  const updateTodo = useCallback(async (todoId: string, payload: Record<string, unknown>) => {
    setIsMutating(true);
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todoId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await readApiData<TodoItem>(response);
      setTodos((current) => {
        const next = current.map((todo) => (todo.id === updated.id ? updated : todo));
        if (statusFilter === 'archived' && updated.status !== 'archived') {
          return next.filter((todo) => todo.id !== updated.id);
        }
        if (statusFilter === 'open' && updated.status !== 'open') {
          return next.filter((todo) => todo.id !== updated.id);
        }
        if (statusFilter === 'done' && updated.status !== 'done') {
          return next.filter((todo) => todo.id !== updated.id);
        }
        if (statusFilter === 'active' && updated.status === 'archived') {
          return next.filter((todo) => todo.id !== updated.id);
        }
        return next;
      });
      window.dispatchEvent(new CustomEvent('todo_updated'));
      return updated;
    } finally {
      setIsMutating(false);
    }
  }, [statusFilter]);

  const handleSelectTodo = useCallback(async (todo: TodoItem) => {
    setSelectedTodoId(todo.id);
    if (!todo.seenAt) {
      try {
        await updateTodo(todo.id, { markSeen: true });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.markSeenFailed'));
      }
    }
  }, [t, updateTodo]);

  const todoIdParam = searchParams.get('todo');

  useEffect(() => {
    if (
      !todoIdParam
      || openedTodoParamRef.current === todoIdParam
      || pendingTodoParamRef.current === todoIdParam
    ) {
      return;
    }

    pendingTodoParamRef.current = todoIdParam;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        let todo = todos.find((item) => item.id === todoIdParam) ?? null;

        if (!todo) {
          const response = await fetch(`/api/todos/${encodeURIComponent(todoIdParam)}`, {
            credentials: 'include',
            cache: 'no-store',
          });
          const fetchedTodo = await readApiData<TodoItem>(response);
          todo = fetchedTodo;
          if (cancelled) return;
          setTodos((current) => {
            const exists = current.some((item) => item.id === fetchedTodo.id);
            return exists
              ? current.map((item) => (item.id === fetchedTodo.id ? fetchedTodo : item))
              : [fetchedTodo, ...current];
          });
        }

        if (cancelled) return;
        openedTodoParamRef.current = todoIdParam;
        await handleSelectTodo(todo);
      })().catch((error) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
        }
      }).finally(() => {
        if (pendingTodoParamRef.current === todoIdParam) {
          pendingTodoParamRef.current = null;
        }
      });
    }, 0);
    return () => {
      cancelled = true;
      if (pendingTodoParamRef.current === todoIdParam) {
        pendingTodoParamRef.current = null;
      }
      window.clearTimeout(handle);
    };
  }, [handleSelectTodo, t, todoIdParam, todos]);

  const openCreateDialog = useCallback(() => {
    setEditingTodoId(null);
    setForm({
      ...emptyForm,
      categoryId: categoryFilter || categories[0]?.id || '',
    });
    setFileQuery('');
    setFileResults([]);
    setEditorOpen(true);
  }, [categories, categoryFilter]);

  const openEditDialog = useCallback((todo: TodoItem) => {
    setEditingTodoId(todo.id);
    setForm(todoToForm(todo));
    setFileQuery('');
    setFileResults([]);
    setEditorOpen(true);
  }, []);

  const saveTodo = useCallback(async () => {
    if (!form.title.trim()) {
      toast.error(t('errors.titleRequired'));
      return;
    }

    setIsMutating(true);
    try {
      const payload = {
        title: form.title,
        description: form.description || null,
        categoryId: form.categoryId || null,
        priority: form.priority,
        dueAt: form.dueAt || null,
        fileLinks: form.fileLinks,
      };
      const response = await fetch(editingTodoId ? `/api/todos/${encodeURIComponent(editingTodoId)}` : '/api/todos', {
        method: editingTodoId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await readApiData<TodoItem>(response);
      await loadTodos();
      setSelectedTodoId(saved.id);
      setEditorOpen(false);
      window.dispatchEvent(new CustomEvent('todo_updated'));
      toast.success(editingTodoId ? t('toasts.updated') : t('toasts.created'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
    } finally {
      setIsMutating(false);
    }
  }, [editingTodoId, form, loadTodos, t]);

  const archiveTodo = useCallback(async (todo: TodoItem) => {
    setIsMutating(true);
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todo.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await readApiData<TodoItem>(response);
      setTodos((current) => current.filter((item) => item.id !== todo.id));
      setSelectedTodoId((current) => (current === todo.id ? null : current));
      window.dispatchEvent(new CustomEvent('todo_updated'));
      toast.success(t('toasts.archived'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.archiveFailed'));
    } finally {
      setIsMutating(false);
    }
  }, [t]);

  const toggleDone = useCallback(async (todo: TodoItem) => {
    try {
      const nextStatus = todo.status === 'done' ? 'open' : 'done';
      await updateTodo(todo.id, { status: nextStatus, markSeen: true });
      toast.success(nextStatus === 'done' ? t('toasts.completed') : t('toasts.reopened'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
    }
  }, [t, updateTodo]);

  const sendTodoFollowUp = useCallback(async (todo: TodoItem) => {
    if (!todo.sourceSessionId) return;

    setIsSendingFollowUp(true);
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todo.id)}/follow-up`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: followUpComment,
          locale,
        }),
      });
      const data = await readApiData<TodoFollowUpResponse>(response);
      setTodos((current) => current.map((item) => (item.id === data.todo.id ? data.todo : item)));
      setSelectedTodoId(data.todo.id);
      window.dispatchEvent(new CustomEvent('todo_updated'));
      toast.success(t('toasts.followUpSent'));
      openDockChatSession(data.sessionId);
      pushTodoChatState(data.todo);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.followUpFailed'));
    } finally {
      setIsSendingFollowUp(false);
    }
  }, [followUpComment, locale, t]);

  const restoreTodo = useCallback(async (todo: TodoItem) => {
    try {
      await updateTodo(todo.id, { status: 'open', markSeen: true });
      toast.success(t('toasts.restored'));
      setSelectedTodoId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
    }
  }, [t, updateTodo]);

  const markAllVisibleSeen = useCallback(async () => {
    const unreadTodos = todos.filter((todo) => todo.status !== 'archived' && !todo.seenAt);
    if (unreadTodos.length === 0) return;
    setIsMutating(true);
    try {
      await Promise.all(unreadTodos.map((todo) => fetch(`/api/todos/${encodeURIComponent(todo.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markSeen: true }),
      }).then((response) => readApiData<TodoItem>(response))));
      await loadTodos();
      window.dispatchEvent(new CustomEvent('todo_updated'));
      toast.success(t('toasts.markedAllSeen'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.markSeenFailed'));
    } finally {
      setIsMutating(false);
    }
  }, [loadTodos, t, todos]);

  const saveCategory = useCallback(async () => {
    if (!categoryDraft.name.trim()) {
      toast.error(t('errors.categoryNameRequired'));
      return;
    }

    setIsMutating(true);
    try {
      const response = await fetch(
        editingCategory ? `/api/todo-categories/${encodeURIComponent(editingCategory.id)}` : '/api/todo-categories',
        {
          method: editingCategory ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: categoryDraft.name,
            color: categoryDraft.color,
          }),
        },
      );
      const saved = await readApiData<TodoCategory>(response);
      await loadCategories();
      setCategoryFilter(saved.id);
      setCategoryDialogOpen(false);
      toast.success(editingCategory ? t('toasts.categoryUpdated') : t('toasts.categoryCreated'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.categorySaveFailed'));
    } finally {
      setIsMutating(false);
    }
  }, [categoryDraft, editingCategory, loadCategories, t]);

  const archiveCategory = useCallback(async (category: TodoCategory) => {
    setIsMutating(true);
    try {
      const response = await fetch(`/api/todo-categories/${encodeURIComponent(category.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await readApiData<TodoCategory>(response);
      await loadCategories();
      if (categoryFilter === category.id) setCategoryFilter('');
      setCategoryDialogOpen(false);
      toast.success(t('toasts.categoryArchived'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.categorySaveFailed'));
    } finally {
      setIsMutating(false);
    }
  }, [categoryFilter, loadCategories, t]);

  const addFileLink = useCallback((file: WorkspaceFileEntry) => {
    if (file.type !== 'file') return;
    setForm((current) => {
      if (current.fileLinks.some((link) => link.workspacePath === file.path)) return current;
      return {
        ...current,
        fileLinks: [...current.fileLinks, { workspacePath: file.path, label: file.name }],
      };
    });
  }, []);

  const removeFileLink = useCallback((workspacePath: string) => {
    setForm((current) => ({
      ...current,
      fileLinks: current.fileLinks.filter((link) => link.workspacePath !== workspacePath),
    }));
  }, []);

  const openCategoryDialog = useCallback((category?: TodoCategory) => {
    setEditingCategory(category ?? null);
    setCategoryDraft({
      name: category?.name ?? '',
      color: category?.color ?? '#3b82f6',
    });
    setCategoryDialogOpen(true);
  }, []);

  const renderStatusFilters = (closeOnSelect = false) => (
    <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
      {statusFilters.map((filter) => (
        <button
          key={filter}
          type="button"
          className={cn(
            'flex h-9 min-w-0 items-center justify-between gap-2 rounded-md px-3 text-sm transition-colors',
            statusFilter === filter
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          onClick={() => {
            setStatusFilter(filter);
            if (closeOnSelect) setFilterSheetOpen(false);
          }}
        >
          <span className="min-w-0 truncate">{t(`filters.status.${filter}`)}</span>
        </button>
      ))}
    </div>
  );

  const renderCategoryFilters = (closeOnSelect = false) => (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-testid="todo-category-filter"
        className={cn(
          'flex h-9 min-w-0 items-center justify-between gap-2 rounded-md px-3 text-sm transition-colors',
          !categoryFilter
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        onClick={() => {
          setCategoryFilter('');
          if (closeOnSelect) setFilterSheetOpen(false);
        }}
      >
        <span className="min-w-0 truncate">{t('filters.allCategories')}</span>
      </button>
      {categories.map((category) => (
        <div key={category.id} className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            data-testid="todo-category-filter"
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-sm transition-colors',
              categoryFilter === category.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => {
              setCategoryFilter(category.id);
              if (closeOnSelect) setFilterSheetOpen(false);
            }}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: category.color ?? '#64748b' }}
            />
            <span className="min-w-0 truncate">{formatCategoryName(category)}</span>
          </button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={t('actions.categoryActions')}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => {
                if (closeOnSelect) setFilterSheetOpen(false);
                openCategoryDialog(category);
              }}>
                <Edit3 className="h-4 w-4" />
                {t('actions.renameCategory')}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => {
                if (closeOnSelect) setFilterSheetOpen(false);
                void archiveCategory(category);
              }}>
                <Trash2 className="h-4 w-4" />
                {t('actions.archiveCategory')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
    </div>
  );

  return (
    <div data-testid="todos-page" className="flex min-h-full w-full min-w-0 flex-col overflow-x-hidden bg-background">
      <div className="border-b border-border bg-background/95 px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('eyebrow')}
            </p>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              data-testid="todo-mark-all-seen"
              variant="outline"
              size="sm"
              className="px-2 sm:px-2.5"
              onClick={markAllVisibleSeen}
              disabled={isMutating || visibleUnreadCount === 0}
            >
              <BellOff className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{t('actions.markAllSeen')}</span>
            </Button>
            <Button variant="outline" size="sm" className="px-2 sm:px-2.5" onClick={() => void refreshAll()} disabled={isLoading}>
              <RefreshCcw className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{t('actions.refresh')}</span>
            </Button>
            <Button data-testid="todo-create-button" size="sm" className="min-w-0" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              <span className="min-w-0 truncate">{t('actions.newTodo')}</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full min-w-0 max-w-7xl flex-1 gap-4 p-4 md:grid-cols-[240px_minmax(0,1fr)] md:p-6 xl:grid-cols-[260px_minmax(0,1fr)_360px]">
        <div className="md:hidden">
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-9 w-full min-w-0 justify-between overflow-hidden whitespace-normal py-2 text-left"
            onClick={() => setFilterSheetOpen(true)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Menu className="h-4 w-4 shrink-0" />
              <span className="shrink-0">{t('actions.filters')}</span>
            </span>
            <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{filterSummary}</span>
          </Button>
        </div>

        <aside className="hidden min-w-0 space-y-4 md:block">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('sections.status')}
              </h3>
              <Badge variant="outline">{visibleUnreadCount > 99 ? '99+' : visibleUnreadCount}</Badge>
            </div>
            {renderStatusFilters()}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('sections.categories')}
              </h3>
              <Button variant="ghost" size="icon-xs" onClick={() => openCategoryDialog()} aria-label={t('actions.newCategory')}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {renderCategoryFilters()}
          </section>
        </aside>

        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{selectedCategoryName}</h3>
              <p className="text-xs text-muted-foreground">
                {t('summary', { open: openCount, done: doneCount, unread: visibleUnreadCount })}
              </p>
            </div>
          </div>

          <div className="grid gap-2">
            {isLoading ? (
              <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {t('states.loading')}
              </div>
            ) : todos.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-8 text-center">
                <p className="text-sm font-medium">{t('states.emptyTitle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('states.emptyDescription')}</p>
                <Button className="mt-4" size="sm" onClick={openCreateDialog}>
                  <Plus className="h-4 w-4" />
                  {t('actions.newTodo')}
                </Button>
              </div>
            ) : (
              todos.map((todo) => (
                <article
                  key={todo.id}
                  data-testid="todo-list-item"
                  className={cn(
                    'group min-w-0 overflow-hidden rounded-md border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-accent/60',
                    selectedTodoId === todo.id && 'border-primary/60 bg-accent',
                    todo.status === 'archived' && 'opacity-80',
                  )}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <button
                      type="button"
                      className="mt-0.5 shrink-0 text-muted-foreground transition hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleDone(todo);
                      }}
                      aria-label={todo.status === 'done' ? t('actions.reopen') : t('actions.complete')}
                      disabled={todo.status === 'archived'}
                    >
                      {todo.status === 'done' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Circle className="h-5 w-5" />}
                    </button>

                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void handleSelectTodo(todo)}>
                      <div className="flex min-w-0 items-center gap-2">
                        {!todo.seenAt && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={t('labels.unread')} />}
                        <h4 className={cn('truncate text-sm font-semibold', todo.status === 'done' && 'text-muted-foreground line-through')}>
                          {todo.title}
                        </h4>
                      </div>
                      {todo.description ? (
                        <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{todo.description}</p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        {todo.category && (
                          <Badge variant="outline" className="max-w-full min-w-0 gap-1">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: todo.category.color ?? '#64748b' }} />
                            <span className="min-w-0 truncate">{formatCategoryName(todo.category)}</span>
                          </Badge>
                        )}
                        <Badge variant={todo.priority === 'high' ? 'destructive' : 'secondary'}>
                          {t(`priority.${todo.priority}`)}
                        </Badge>
                        <Badge variant="outline">{t(`source.${todo.sourceType}`)}</Badge>
                        {todo.dueAt && (
                          <Badge variant={isOverdue(todo) ? 'destructive' : 'outline'} className="gap-1">
                            <CalendarDays className="h-3 w-3" />
                            {formatDate(todo.dueAt, locale)}
                          </Badge>
                        )}
                      </div>
                    </button>

                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t('actions.todoActions')}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {todo.status === 'archived' ? (
                          <DropdownMenuItem onSelect={() => void restoreTodo(todo)}>
                            <RefreshCcw className="h-4 w-4" />
                            {t('actions.restore')}
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem onSelect={() => void toggleDone(todo)}>
                              {todo.status === 'done' ? <RefreshCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                              {todo.status === 'done' ? t('actions.reopen') : t('actions.completeQuick')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => openEditDialog(todo)}>
                              <Edit3 className="h-4 w-4" />
                              {t('actions.edit')}
                            </DropdownMenuItem>
                            {!todo.seenAt && (
                              <DropdownMenuItem onSelect={() => void updateTodo(todo.id, { markSeen: true })}>
                                <Check className="h-4 w-4" />
                                {t('actions.markSeen')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem variant="destructive" onSelect={() => void archiveTodo(todo)}>
                              <Archive className="h-4 w-4" />
                              {t('actions.archiveTodo')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <div data-testid="todo-detail" className="min-w-0 overflow-hidden rounded-md border border-border bg-background p-4">
            {selectedTodo ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={selectedTodo.status === 'done' ? 'default' : selectedTodo.status === 'archived' ? 'secondary' : 'outline'}>
                        {t(`status.${selectedTodo.status}`)}
                      </Badge>
                      {!selectedTodo.seenAt && <Badge>{t('labels.unread')}</Badge>}
                    </div>
                    <h3 className="mt-2 break-words text-lg font-semibold leading-tight">{selectedTodo.title}</h3>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => openEditDialog(selectedTodo)} disabled={selectedTodo.status === 'archived'}>
                    <Edit3 className="h-4 w-4" />
                  </Button>
                </div>

                {selectedTodo.description ? (
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{selectedTodo.description}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('states.noDescription')}</p>
                )}

                <div className="grid gap-2 text-sm">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">{t('fields.category')}</span>
                    <span className="min-w-0 truncate text-right font-medium">{formatCategoryName(selectedTodo.category)}</span>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">{t('fields.priority')}</span>
                    <span className="font-medium">{t(`priority.${selectedTodo.priority}`)}</span>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="shrink-0 text-muted-foreground">{t('fields.dueAt')}</span>
                    <span className="min-w-0 truncate text-right font-medium">{formatDate(selectedTodo.dueAt, locale) ?? t('fields.noDueAt')}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t('sections.files')}
                  </h4>
                  {selectedTodo.fileLinks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('states.noFiles')}</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedTodo.fileLinks.map((link) => (
                        <Button key={link.id} asChild variant="outline" className="h-auto w-full min-w-0 justify-start overflow-hidden whitespace-normal py-2 text-left">
                          <Link href={fileLinkHref(link.workspacePath)}>
                            <FileText className="h-4 w-4" />
                            <span className="min-w-0 flex-1 truncate">{link.label || link.workspacePath}</span>
                          </Link>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>

                {selectedTodo.sourceSessionId ? (
                  <div className="space-y-3 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        {t('sections.session')}
                      </h4>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openTodoSession(selectedTodo)}
                      >
                        <ExternalLink className="h-4 w-4" />
                        {t('actions.openSession')}
                      </Button>
                    </div>

                    {selectedTodo.status === 'done' ? (
                      <div className="space-y-2">
                        <Label htmlFor="todo-follow-up-comment">{t('fields.followUpComment')}</Label>
                        <Textarea
                          id="todo-follow-up-comment"
                          value={followUpComment}
                          onChange={(event) => updateFollowUpComment(event.target.value)}
                          className="min-h-24"
                          maxLength={5000}
                          placeholder={t('fields.followUpCommentPlaceholder')}
                        />
                        {selectedTodo.followUpSentAt ? (
                          <p className="text-xs text-muted-foreground">
                            {t('labels.followUpSentAt', { date: formatDate(selectedTodo.followUpSentAt, locale) ?? selectedTodo.followUpSentAt })}
                          </p>
                        ) : null}
                        {selectedTodo.followUpError ? (
                          <p className="break-words text-xs text-destructive">{selectedTodo.followUpError}</p>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void sendTodoFollowUp(selectedTodo)}
                          disabled={isSendingFollowUp || isMutating}
                        >
                          <Send className="h-4 w-4" />
                          {selectedTodo.followUpSentAt ? t('actions.sendFollowUpAgain') : t('actions.sendFollowUp')}
                        </Button>
                      </div>
                    ) : (
                      <p className="flex items-start gap-2 text-sm text-muted-foreground">
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
                        {t('states.completeBeforeFollowUp')}
                      </p>
                    )}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {selectedTodo.status === 'archived' ? (
                    <Button size="sm" onClick={() => void restoreTodo(selectedTodo)} disabled={isMutating}>
                      <RefreshCcw className="h-4 w-4" />
                      {t('actions.restore')}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => void toggleDone(selectedTodo)} disabled={isMutating}>
                        <CheckCircle2 className="h-4 w-4" />
                        {selectedTodo.status === 'done' ? t('actions.reopen') : t('actions.complete')}
                      </Button>
                      {!selectedTodo.seenAt && (
                        <Button size="sm" variant="outline" onClick={() => void updateTodo(selectedTodo.id, { markSeen: true })} disabled={isMutating}>
                          <Check className="h-4 w-4" />
                          {t('actions.markSeen')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <Clock3 className="h-8 w-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">{t('states.noSelectionTitle')}</p>
                <p className="mt-1 max-w-xs text-sm text-muted-foreground">{t('states.noSelectionDescription')}</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[calc(100dvh-1rem)] rounded-t-lg p-0 pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <SheetHeader className="border-b border-border pr-12 text-left">
            <SheetTitle>{t('actions.filters')}</SheetTitle>
            <SheetDescription>{filterSummary}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-4 py-4">
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {t('sections.status')}
                </h3>
                <Badge variant="outline">{visibleUnreadCount > 99 ? '99+' : visibleUnreadCount}</Badge>
              </div>
              {renderStatusFilters(true)}
            </section>

            <section className="mt-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {t('sections.categories')}
                </h3>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setFilterSheetOpen(false);
                    openCategoryDialog();
                  }}
                  aria-label={t('actions.newCategory')}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              {renderCategoryFilters(true)}
            </section>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent layout="viewport" className="mx-auto max-w-4xl">
          <DialogHeader className="shrink-0 border-b px-4 pt-5 pb-4 sm:px-6">
            <DialogTitle>{editingTodoId ? t('editor.editTitle') : t('editor.createTitle')}</DialogTitle>
            <DialogDescription>{t('editor.description')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="todo-title">{t('fields.title')}</Label>
                  <Input
                    id="todo-title"
                    data-testid="todo-editor-title"
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    maxLength={180}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="todo-description">{t('fields.description')}</Label>
                  <Textarea
                    id="todo-description"
                    value={form.description}
                    onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                    className="min-h-36"
                    maxLength={5000}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="space-y-2 text-sm">
                    <span className="font-medium">{t('fields.category')}</span>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={form.categoryId}
                      onChange={(event) => setForm((current) => ({ ...current, categoryId: event.target.value }))}
                    >
                      <option value="">{t('filters.noCategory')}</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>{formatCategoryName(category)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="font-medium">{t('fields.priority')}</span>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={form.priority}
                      onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value as TodoPriority }))}
                    >
                      {priorities.map((priority) => (
                        <option key={priority} value={priority}>{t(`priority.${priority}`)}</option>
                      ))}
                    </select>
                  </label>
                  <div className="space-y-2">
                    <Label htmlFor="todo-due-at">{t('fields.dueAt')}</Label>
                    <Input
                      id="todo-due-at"
                      type="date"
                      value={form.dueAt}
                      onChange={(event) => setForm((current) => ({ ...current, dueAt: event.target.value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="todo-file-search">{t('fields.fileSearch')}</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="todo-file-search"
                      data-testid="todo-file-search"
                      value={fileQuery}
                      onChange={(event) => setFileQuery(event.target.value)}
                      className="pl-9"
                      placeholder={t('fields.fileSearchPlaceholder')}
                    />
                  </div>
                </div>

                <div className="max-h-52 overflow-y-auto rounded-md border border-border">
                  {isFileSearching ? (
                    <div className="p-3 text-sm text-muted-foreground">{t('states.searchingFiles')}</div>
                  ) : fileResults.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">{t('states.noFileResults')}</div>
                  ) : (
                    fileResults.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        data-testid="todo-file-result"
                        className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={file.type !== 'file'}
                        onClick={() => addFileLink(file)}
                      >
                        <FolderSearch className="h-4 w-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{file.path}</span>
                      </button>
                    ))
                  )}
                </div>

                <div className="space-y-2">
                  <h4 className="text-sm font-medium">{t('fields.linkedFiles')}</h4>
                  {form.fileLinks.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                      {t('states.noFiles')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {form.fileLinks.map((link) => (
                        <div key={link.workspacePath} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{link.label || link.workspacePath}</span>
                          <Button variant="ghost" size="icon-xs" onClick={() => removeFileLink(link.workspacePath)} aria-label={t('actions.removeFile')}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t px-4 py-4 sm:px-6">
            <Button variant="outline" onClick={() => setEditorOpen(false)}>{t('actions.cancel')}</Button>
            <Button data-testid="todo-save-button" onClick={() => void saveTodo()} disabled={isMutating}>
              <Check className="h-4 w-4" />
              {t('actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCategory ? t('categoryEditor.editTitle') : t('categoryEditor.createTitle')}</DialogTitle>
            <DialogDescription>{t('categoryEditor.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="todo-category-name">{t('fields.categoryName')}</Label>
              <Input
                id="todo-category-name"
                value={categoryDraft.name}
                onChange={(event) => setCategoryDraft((current) => ({ ...current, name: event.target.value }))}
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="todo-category-color">{t('fields.categoryColor')}</Label>
              <div className="flex items-center gap-3">
                <input
                  id="todo-category-color"
                  type="color"
                  value={categoryDraft.color}
                  onChange={(event) => setCategoryDraft((current) => ({ ...current, color: event.target.value }))}
                  className="h-9 w-12 rounded-md border border-input bg-background"
                />
                <Input
                  value={categoryDraft.color}
                  onChange={(event) => setCategoryDraft((current) => ({ ...current, color: event.target.value }))}
                  maxLength={24}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            {editingCategory && (
              <Button variant="destructive" onClick={() => void archiveCategory(editingCategory)} disabled={isMutating}>
                <Trash2 className="h-4 w-4" />
                {t('actions.archiveCategory')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setCategoryDialogOpen(false)}>{t('actions.cancel')}</Button>
            <Button onClick={() => void saveCategory()} disabled={isMutating}>{t('actions.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
