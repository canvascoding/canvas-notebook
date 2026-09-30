'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  BellOff,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  Edit3,
  FolderKanban,
  Globe2,
  MailCheck,
  MailWarning,
  MailOpen,
  Menu,
  ListTodo,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';

import { getDefaultTodoCategoryKey } from '@/app/lib/todos/default-categories';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import { dispatchOpenChatSession } from '@/app/lib/chat/open-chat-session-event';
import {
  listWorkspaceFileReferences,
  type WorkspaceFileReferenceEntry,
} from '@/app/lib/files/client';
import { resolveTodoById } from './todo-selection';
import { useTodoBulkSelection } from './todo-bulk-selection';
import { TodoBulkToolbar, TodoSelectionCheckbox } from './TodoBulkToolbar';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useSetTodoChatContext } from '@/app/apps/todos/context/todo-chat-context';
import { buildTodoPageChatContext } from '@/app/apps/todos/context/todo-route-chat-context';
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
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import type { TodoStatus, TodoPriority, TodoCategory, TodoItem, TodoWorkspaceType, TodoFormState, AssigneeOption, TodoListScope } from '@/app/lib/todos/client-types';
import { TodoIcon, resolvedTodoIconKey, formatDate, isOverdue, todoToForm, emptyForm, priorities, todoFormPayload } from '@/app/lib/todos/client-presentation';
import { TodoDetailPanel } from './TodoDetailPanel';
import { TodoEditorFields } from './TodoEditorFields';

type StatusFilter = TodoStatus | 'all';
type ReadStateFilter = 'all' | 'read' | 'unread';
type WorkspaceFileEntry = WorkspaceFileReferenceEntry;

function todoMatchesStatusFilter(todoStatus: TodoStatus, statusFilter: StatusFilter): boolean {
  return statusFilter === 'all' || todoStatus === statusFilter;
}

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type WorkspaceOption = {
  id: string;
  type: TodoWorkspaceType | 'project';
  name: string;
  organizationId: string | null;
  permissions?: {
    canRead?: boolean;
    canWrite?: boolean;
  };
};

type TodoFollowUpResponse = {
  todo: TodoItem;
  sessionId: string;
};

const statusFilters: StatusFilter[] = ['open', 'done', 'archived', 'all'];
const readStateFilters: ReadStateFilter[] = ['all', 'unread', 'read'];

const statusFilterIcons: Record<StatusFilter, typeof Circle> = {
  all: ListTodo,
  open: Circle,
  done: CheckCircle2,
  archived: Archive,
};

const readStateFilterIcons: Record<ReadStateFilter, typeof Circle> = {
  all: MailOpen,
  unread: MailWarning,
  read: MailCheck,
};

const priorityFilterIcons: Record<TodoPriority, typeof Circle> = {
  low: ArrowDown,
  normal: Minus,
  high: ArrowUp,
};

async function readApiData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
  if (!response.ok || !payload?.success || payload.data === undefined) {
    throw new Error(payload?.error || 'Request failed');
  }
  return payload.data;
}

function pushTodoChatState(todo: Pick<TodoItem, 'id' | 'sourceSessionId' | 'workspaceId'>) {
  if (!todo.sourceSessionId || typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  url.searchParams.set('todo', todo.id);
  url.searchParams.set('todoView', 'page');
  const nextPath = buildChatSessionHref(
    `${url.pathname}?${url.searchParams.toString()}${url.hash}`,
    todo.sourceSessionId,
    todo.workspaceId,
  );
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextPath !== currentPath) {
    window.history.pushState({ todoId: todo.id, sessionId: todo.sourceSessionId, workspaceId: todo.workspaceId }, '', nextPath);
  }
}

function openDockChatSession(sessionId: string | null, workspaceId?: string | null) {
  if (!sessionId || typeof window === 'undefined') return;
  dispatchOpenChatSession(sessionId, 'todo', workspaceId);
}

export function TodosClient({ title }: { title: string }) {
  const t = useTranslations('todos');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const openedTodoParamRef = useRef<string | null>(null);
  const pendingTodoParamRef = useRef<string | null>(null);
  const initializedWorkspaceScopeRef = useRef(false);
  const todoListRequestRef = useRef<AbortController | null>(null);
  const todoIdParam = searchParams.get('todoView') === 'page' ? searchParams.get('todo') : null;
  const requestedWorkspaceId = searchParams.get('workspaceId');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaceStoreInitialized = useWorkspaceStore((state) => state.initialized);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [categories, setCategories] = useState<TodoCategory[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => requestedWorkspaceId || '');
  const [listScope, setListScope] = useState<TodoListScope>(() => requestedWorkspaceId ? 'workspace' : 'personal');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [readStateFilter, setReadStateFilter] = useState<ReadStateFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<TodoPriority | ''>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [selectedTodoSnapshot, setSelectedTodoSnapshot] = useState<TodoItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadedFilterKey, setLoadedFilterKey] = useState('');
  const [isMutating, setIsMutating] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [isMobileDetailViewport, setIsMobileDetailViewport] = useState(() => (
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 767px)').matches
      : false
  ));
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
  const setTodoChatContext = useSetTodoChatContext();

  const selectedTodo = useMemo(
    () => resolveTodoById(todos, selectedTodoId, selectedTodoSnapshot),
    [selectedTodoId, selectedTodoSnapshot, todos],
  );
  const visibleTodos = useMemo(
    () => todos.filter((todo) => todoMatchesStatusFilter(todo.status, statusFilter)),
    [statusFilter, todos],
  );

  useEffect(() => {
    setTodoChatContext(buildTodoPageChatContext(selectedTodoId));
    return () => setTodoChatContext(null);
  }, [selectedTodoId, setTodoChatContext]);
  const editingTodo = useMemo(
    () => resolveTodoById(todos, editingTodoId, selectedTodoSnapshot),
    [editingTodoId, selectedTodoSnapshot, todos],
  );

  const followUpComment = selectedTodo && followUpDraft.todoId === selectedTodo.id
    ? followUpDraft.value
    : selectedTodo?.completionComment ?? '';

  const updateFollowUpComment = useCallback((value: string) => {
    if (!selectedTodo) return;
    setFollowUpDraft({ todoId: selectedTodo.id, value });
  }, [selectedTodo]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const updateViewport = (event: MediaQueryListEvent) => {
      setIsMobileDetailViewport(event.matches);
      if (!event.matches) {
        setDetailDialogOpen(false);
      }
    };

    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  const openTodoSession = useCallback((todo: Pick<TodoItem, 'id' | 'sourceSessionId' | 'workspaceId'>) => {
    pushTodoChatState(todo);
    openDockChatSession(todo.sourceSessionId, todo.workspaceId);
  }, []);

  const visibleUnreadCount = useMemo(
    () => todos.filter((todo) => todo.readState === 'unread').length,
    [todos],
  );

  const openCount = useMemo(() => todos.filter((todo) => todo.status === 'open').length, [todos]);
  const doneCount = useMemo(() => todos.filter((todo) => todo.status === 'done').length, [todos]);
  const readableWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.permissions?.canRead !== false),
    [workspaces],
  );
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const selectedWorkspaceLabel = listScope === 'global'
    ? t('scope.global')
    : listScope === 'personal'
      ? t('scope.personal')
      : selectedWorkspace?.name || t('scope.workspace');

  const formatTodoScope = useCallback((todo: Pick<TodoItem, 'scopeKind' | 'workspace' | 'workspaceType'>) => (
    todo.scopeKind === 'user'
      ? t('scope.user')
      : todo.workspace?.name || t(`workspaceType.${todo.workspaceType}`)
  ), [t]);

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
    () => `${selectedWorkspaceLabel} · ${t(`filters.status.${statusFilter}`)} · ${t(`filters.readState.${readStateFilter}`)} · ${priorityFilter ? t(`priority.${priorityFilter}`) : t('filters.allPriorities')} · ${selectedCategoryName}`,
    [priorityFilter, readStateFilter, selectedCategoryName, selectedWorkspaceLabel, statusFilter, t],
  );

  const loadWorkspaces = useCallback(async () => {
    const response = await fetch('/api/workspaces', { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => null) as { success?: boolean; workspaces?: WorkspaceOption[] } | null;
    if (!response.ok || !payload?.success) {
      setWorkspaces([]);
      return [];
    }
    const readable = (payload.workspaces ?? []).filter((workspace) => (
      (workspace.type === 'personal' || workspace.type === 'organization' || workspace.type === 'team' || workspace.type === 'project')
      && workspace.permissions?.canRead !== false
    ));
    setWorkspaces(readable as WorkspaceOption[]);
    setSelectedWorkspaceId((current) => {
      if (initializedWorkspaceScopeRef.current) {
        return current && readable.some((workspace) => workspace.id === current) ? current : '';
      }
      if (current && readable.some((workspace) => workspace.id === current)) {
        initializedWorkspaceScopeRef.current = true;
        return current;
      }
      const preferredWorkspaceId = requestedWorkspaceId || (workspaceStoreInitialized ? activeWorkspaceId : null);
      if (preferredWorkspaceId && readable.some((workspace) => workspace.id === preferredWorkspaceId)) {
        initializedWorkspaceScopeRef.current = true;
        return preferredWorkspaceId;
      }
      if (requestedWorkspaceId || workspaceStoreInitialized) {
        initializedWorkspaceScopeRef.current = true;
      }
      return '';
    });
    return readable;
  }, [activeWorkspaceId, requestedWorkspaceId, workspaceStoreInitialized]);

  const loadCategories = useCallback(async () => {
    const response = await fetch('/api/todo-categories', { credentials: 'include', cache: 'no-store' });
    const data = await readApiData<TodoCategory[]>(response);
    setCategories(data);
    return data;
  }, []);

  const loadAssignees = useCallback(async () => {
    const params = new URLSearchParams();
    if (listScope === 'workspace' && selectedWorkspaceId) params.set('workspaceId', selectedWorkspaceId);
    const response = await fetch(`/api/todos/assignees?${params.toString()}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const data = await readApiData<AssigneeOption[]>(response);
    setAssignees(data);
    return data;
  }, [listScope, selectedWorkspaceId]);

  const bulkFilterParams = new URLSearchParams({ status: statusFilter });
  if (categoryFilter) bulkFilterParams.set('categoryId', categoryFilter);
  bulkFilterParams.set('scope', listScope);
  if (listScope === 'workspace' && selectedWorkspaceId) bulkFilterParams.set('workspaceId', selectedWorkspaceId);
  if (priorityFilter) bulkFilterParams.set('priority', priorityFilter);
  if (readStateFilter !== 'all') bulkFilterParams.set('readState', readStateFilter);
  const bulkFilterKey = bulkFilterParams.toString();

  const loadTodos = useCallback(async () => {
    todoListRequestRef.current?.abort();
    const controller = new AbortController();
    todoListRequestRef.current = controller;
    try {
      const response = await fetch(`/api/todos?${bulkFilterKey}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await readApiData<TodoItem[]>(response);
      if (controller.signal.aborted || todoListRequestRef.current !== controller) {
        return data;
      }

      setTodos(data);
      setLoadedFilterKey(bulkFilterKey);
      setSelectedTodoId((current) => (
        current && (data.some((todo) => todo.id === current) || current === todoIdParam)
          ? current
          : null
      ));
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        return [];
      }
      throw error;
    } finally {
      if (todoListRequestRef.current === controller) {
        todoListRequestRef.current = null;
      }
    }
  }, [bulkFilterKey, todoIdParam]);
  const bulk = useTodoBulkSelection(bulkFilterKey, async (ids) => {
    if (selectedTodoId && ids.includes(selectedTodoId)) {
      setSelectedTodoId(null);
      setSelectedTodoSnapshot(null);
      setDetailDialogOpen(false);
    }
    // The existing event listener reloads this list and other to-do consumers.
    window.dispatchEvent(new CustomEvent('todo_updated'));
  });
  const bulkDisabled = isMutating || isLoading || loadedFilterKey !== bulkFilterKey;

  const refreshAll = useCallback(async () => {
    setIsLoading(true);
    try {
      await Promise.all([loadAssignees(), loadCategories(), loadTodos(), loadWorkspaces()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [loadAssignees, loadCategories, loadTodos, loadWorkspaces, t]);

  useEffect(() => {
    async function loadStaticData() {
      try {
        await Promise.all([loadCategories(), loadWorkspaces()]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
      }
    }

    void loadStaticData();
  }, [loadCategories, loadWorkspaces, t]);

  useEffect(() => {
    let cancelled = false;

    async function loadScopedData() {
      setIsLoading(true);
      try {
        await Promise.all([loadAssignees(), loadTodos()]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadScopedData();
    return () => {
      cancelled = true;
    };
  }, [loadAssignees, loadTodos, t]);

  useEffect(() => {
    const refreshTodos = () => {
      void loadTodos().catch((error) => {
        toast.error(error instanceof Error ? error.message : t('errors.loadFailed'));
      });
    };
    window.addEventListener('todo_updated', refreshTodos);
    return () => window.removeEventListener('todo_updated', refreshTodos);
  }, [loadTodos, t]);

  useEffect(() => {
    if (!editorOpen) return;

    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      setIsFileSearching(true);
      try {
        if (!selectedWorkspaceId) throw new Error('Workspace context is not ready');
        const files = await listWorkspaceFileReferences({
          query: fileQuery,
          limit: 20,
          workspaceId: selectedWorkspaceId,
          signal: controller.signal,
        });
        setFileResults(files as WorkspaceFileEntry[]);
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
  }, [editorOpen, fileQuery, selectedWorkspaceId]);

  const updateTodo = useCallback(async (todoId: string, payload: Record<string, unknown>) => {
    todoListRequestRef.current?.abort();
    setIsMutating(true);
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todoId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await readApiData<TodoItem>(response);
      setSelectedTodoSnapshot((current) => (current?.id === updated.id ? updated : current));
      await loadTodos();
      window.dispatchEvent(new CustomEvent('todo_updated'));
      return updated;
    } finally {
      setIsMutating(false);
    }
  }, [loadTodos]);

  const handleSelectTodo = useCallback(async (todo: TodoItem) => {
    setSelectedTodoId(todo.id);
    if (isMobileDetailViewport) {
      setDetailDialogOpen(true);
    }
    if (todo.readState === 'unread') {
      try {
        await updateTodo(todo.id, { markSeen: true });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.markSeenFailed'));
      }
    }
  }, [isMobileDetailViewport, t, updateTodo]);

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
          setSelectedTodoSnapshot(fetchedTodo);
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
    if (!todo.canWrite || todo.status === 'archived') return;
    setSelectedWorkspaceId(todo.scopeKind === 'workspace' ? todo.workspaceId || '' : '');
    setListScope(todo.scopeKind === 'workspace' ? 'workspace' : 'personal');
    setEditingTodoId(todo.id);
    setForm(todoToForm(todo));
    setFileQuery('');
    setFileResults([]);
    setEditorOpen(true);
  }, []);

  const saveTodo = useCallback(async () => {
    if (editingTodoId && (!editingTodo?.canWrite || editingTodo.status === 'archived')) return;
    if (!form.title.trim()) {
      toast.error(t('errors.titleRequired'));
      return;
    }

    todoListRequestRef.current?.abort();
    setIsMutating(true);
    try {
      const payload = {
        ...todoFormPayload(form, editingTodo),
        ...(!editingTodoId ? {
          scopeKind: listScope === 'workspace' && selectedWorkspaceId ? 'workspace' : 'user',
          ...(listScope === 'workspace' && selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
        } : {}),
      };
      const response = await fetch(editingTodoId ? `/api/todos/${encodeURIComponent(editingTodoId)}` : '/api/todos', {
        method: editingTodoId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await readApiData<TodoItem>(response);
      setSelectedTodoSnapshot(saved);
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
  }, [editingTodo, editingTodoId, form, listScope, loadTodos, selectedWorkspaceId, t]);

  const archiveTodo = useCallback(async (todo: TodoItem) => {
    if (!todo.canWrite) return;
    todoListRequestRef.current?.abort();
    setIsMutating(true);
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todo.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await readApiData<TodoItem>(response);
      setSelectedTodoSnapshot((current) => (current?.id === todo.id ? null : current));
      await loadTodos();
      setSelectedTodoId((current) => (current === todo.id ? null : current));
      window.dispatchEvent(new CustomEvent('todo_updated'));
      toast.success(t('toasts.archived'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.archiveFailed'));
    } finally {
      setIsMutating(false);
    }
  }, [loadTodos, t]);

  const toggleDone = useCallback(async (todo: TodoItem) => {
    if (!todo.canWrite) return;
    try {
      const nextStatus = todo.status === 'done' ? 'open' : 'done';
      await updateTodo(todo.id, { status: nextStatus, markSeen: true });
      toast.success(nextStatus === 'done' ? t('toasts.completed') : t('toasts.reopened'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
    }
  }, [t, updateTodo]);

  const sendTodoFollowUp = useCallback(async (todo: TodoItem) => {
    if (!todo.sourceSessionId || !todo.canWrite) return;

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
      setSelectedTodoSnapshot((current) => (current?.id === data.todo.id ? data.todo : current));
      setSelectedTodoId(data.todo.id);
      window.dispatchEvent(new CustomEvent('todo_updated'));
      toast.success(t('toasts.followUpSent'));
      pushTodoChatState(data.todo);
      openDockChatSession(data.sessionId, data.todo.workspaceId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.followUpFailed'));
    } finally {
      setIsSendingFollowUp(false);
    }
  }, [followUpComment, locale, t]);

  const restoreTodo = useCallback(async (todo: TodoItem) => {
    if (!todo.canWrite) return;
    try {
      await updateTodo(todo.id, { status: 'open', markSeen: true });
      toast.success(t('toasts.restored'));
      setSelectedTodoId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
    }
  }, [t, updateTodo]);

  const markAllVisibleSeen = useCallback(async () => {
    const unreadTodos = todos.filter((todo) => todo.readState === 'unread');
    if (unreadTodos.length === 0) return;
    todoListRequestRef.current?.abort();
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
          {(() => {
            const Icon = statusFilterIcons[filter];
            return <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
          })()}
          <span className="min-w-0 truncate">{t(`filters.status.${filter}`)}</span>
        </button>
      ))}
    </div>
  );

  const renderReadStateFilters = (closeOnSelect = false) => (
    <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
      {readStateFilters.map((filter) => (
        <button
          key={filter}
          type="button"
          className={cn(
            'flex h-9 min-w-0 items-center justify-between gap-2 rounded-md px-3 text-sm transition-colors',
            readStateFilter === filter
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          onClick={() => {
            setReadStateFilter(filter);
            if (closeOnSelect) setFilterSheetOpen(false);
          }}
        >
          {(() => {
            const Icon = readStateFilterIcons[filter];
            return <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
          })()}
          <span className="min-w-0 truncate">{t(`filters.readState.${filter}`)}</span>
        </button>
      ))}
    </div>
  );

  const renderPriorityFilters = (closeOnSelect = false) => (
    <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
      <button
        type="button"
        className={cn(
          'flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors',
          !priorityFilter ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        onClick={() => { setPriorityFilter(''); if (closeOnSelect) setFilterSheetOpen(false); }}
      >
        <ListTodo className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{t('filters.allPriorities')}</span>
      </button>
      {priorities.map((priority) => (
        <button
          key={priority}
          type="button"
          className={cn(
            'flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors',
            priorityFilter === priority ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          onClick={() => { setPriorityFilter(priority); if (closeOnSelect) setFilterSheetOpen(false); }}
        >
          {(() => {
            const Icon = priorityFilterIcons[priority];
            return <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
          })()}
          <span className="min-w-0 truncate">{t(`priority.${priority}`)}</span>
        </button>
      ))}
    </div>
  );

  const renderWorkspaceFilters = (closeOnSelect = false) => (
    <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
      <button
        type="button"
        className={cn(
          'flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors',
          listScope === 'personal'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        onClick={() => {
          setSelectedWorkspaceId('');
          setListScope('personal');
          setSelectedTodoId(null);
          if (closeOnSelect) setFilterSheetOpen(false);
        }}
      >
        <UserRound className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t('scope.personal')}</span>
      </button>
      <button
        type="button"
        className={cn(
          'flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors',
          listScope === 'global'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        onClick={() => {
          setSelectedWorkspaceId('');
          setListScope('global');
          setSelectedTodoId(null);
          if (closeOnSelect) setFilterSheetOpen(false);
        }}
      >
        <Globe2 className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t('scope.global')}</span>
      </button>
      {readableWorkspaces.map((workspace) => {
        const WorkspaceIcon = workspace.type === 'personal'
          ? UserRound
          : workspace.type === 'project'
            ? FolderKanban
            : workspace.type === 'organization'
              ? Building2
              : Users;
        return (
        <button
          key={workspace.id}
          type="button"
          className={cn(
            'flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors',
            listScope === 'workspace' && selectedWorkspaceId === workspace.id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          onClick={() => {
            setSelectedWorkspaceId(workspace.id);
            setListScope('workspace');
            setSelectedTodoId(null);
            if (closeOnSelect) setFilterSheetOpen(false);
          }}
        >
          <WorkspaceIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{workspace.name || t(`workspaceType.${workspace.type}`)}</span>
        </button>
        );
      })}
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
    <div data-testid="todos-page" className="flex min-h-full w-full min-w-0 flex-col overflow-x-hidden bg-background md:h-full md:min-h-0 md:overflow-hidden">
      <div className="flex-shrink-0 border-b border-border bg-background/95 px-4 py-4 md:px-6">
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
              disabled={isMutating || bulk.busy || visibleUnreadCount === 0}
            >
              <BellOff className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{t('actions.markAllSeen')}</span>
            </Button>
            <Button variant="outline" size="sm" className="px-2 sm:px-2.5" onClick={() => void refreshAll()} disabled={isLoading || bulk.busy}>
              <RefreshCcw className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{t('actions.refresh')}</span>
            </Button>
            <Button data-testid="todo-create-button" size="sm" className="min-w-0" disabled={bulk.busy} onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              <span className="min-w-0 truncate">{t('actions.newTodo')}</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full min-w-0 max-w-7xl flex-1 grid-cols-1 gap-4 p-4 md:min-h-0 md:grid-cols-[240px_minmax(0,1fr)] md:overflow-hidden md:p-6 xl:grid-cols-[260px_minmax(0,1fr)_360px]">
        <div className="md:hidden">
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-9 w-full min-w-0 justify-between overflow-hidden whitespace-normal py-2 text-left"
            onClick={() => setFilterSheetOpen(true)}
          >
            <span className="flex shrink-0 items-center gap-2">
              <Menu className="h-4 w-4 shrink-0" />
              <span className="shrink-0">{t('actions.filters')}</span>
            </span>
            <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{filterSummary}</span>
          </Button>
        </div>

        <aside className="hidden min-h-0 min-w-0 space-y-4 md:block md:overflow-y-auto md:overscroll-contain">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('sections.workspace')}
            </h3>
            {renderWorkspaceFilters()}
          </section>

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
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('sections.readState')}
            </h3>
            {renderReadStateFilters()}
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('sections.priority')}
            </h3>
            {renderPriorityFilters()}
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

        <section className="min-h-0 min-w-0 space-y-3 md:overflow-y-auto md:overscroll-contain" aria-label={t('title')} tabIndex={-1}
          onKeyDown={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('textarea, select, input:not([type="checkbox"]), [contenteditable="true"], [role="dialog"]')) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !bulkDisabled && !bulk.busy) {
              event.preventDefault();
              event.currentTarget.focus();
              void bulk.selectAll();
            } else if (event.key === 'Escape' && !bulk.busy) bulk.clear();
          }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{selectedCategoryName}</h3>
              <p className="text-xs text-muted-foreground">
                {t('summary', { open: openCount, done: doneCount, unread: visibleUnreadCount })}
              </p>
            </div>
          </div>

          <TodoBulkToolbar key={bulkFilterKey} selection={bulk} disabled={bulkDisabled}
            categories={categories.filter((category) => !category.isArchived).map((category) => ({ id: category.id, name: formatCategoryName(category) }))} assignees={assignees} />

          <div className="grid gap-2">
            {isLoading ? (
              <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {t('states.loading')}
              </div>
            ) : visibleTodos.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-8 text-center">
                <p className="text-sm font-medium">{t('states.emptyTitle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('states.emptyDescription')}</p>
                <Button className="mt-4" size="sm" onClick={openCreateDialog}>
                  <Plus className="h-4 w-4" />
                  {t('actions.newTodo')}
                </Button>
              </div>
            ) : (
              visibleTodos.map((todo) => (
                <article
                  key={todo.id}
                  data-testid="todo-list-item"
                  className={cn(
                    'group min-w-0 overflow-hidden rounded-md border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-accent/60',
                    selectedTodoId === todo.id && 'border-primary/60 bg-accent',
                    bulk.items.has(todo.id) && 'border-primary bg-primary/5 ring-1 ring-primary/20',
                    todo.status === 'archived' && 'opacity-80',
                  )}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <TodoSelectionCheckbox label={t(todo.canWrite ? 'bulk.select' : 'bulk.readonly', { title: todo.title })}
                      checked={bulk.items.has(todo.id)} disabled={bulkDisabled || bulk.busy || bulk.selecting || !todo.canWrite}
                      onChange={() => bulk.toggle(todo)} />
                    <button
                      type="button"
                      className="mt-0.5 shrink-0 text-muted-foreground transition hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleDone(todo);
                      }}
                      aria-label={todo.status === 'done' ? t('actions.reopen') : t('actions.complete')}
                      disabled={!todo.canWrite || todo.status === 'archived' || bulk.busy || isMutating}
                    >
                      {todo.status === 'done' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Circle className="h-5 w-5" />}
                    </button>

                    <div
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      onClick={(event) => {
                        const target = event.target;
                        if (target instanceof Element && target.closest('a, button, input, select, textarea, [role="button"]')) return;
                        void handleSelectTodo(todo);
                      }}
                    >
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 text-left"
                        onClick={() => void handleSelectTodo(todo)}
                      >
                        {todo.readState === 'unread' && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={t('labels.unread')} />}
                        <TodoIcon iconKey={resolvedTodoIconKey(todo)} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <h4 className={cn('truncate text-sm font-semibold', todo.status === 'done' && 'text-muted-foreground line-through')}>
                          {todo.title}
                        </h4>
                      </button>
                      {todo.description ? (
                        <div className="mt-1 max-h-10 overflow-hidden text-sm text-muted-foreground [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_pre]:max-h-10 [&_table]:text-[0.65rem] [&_img]:max-h-8 [&_img]:max-w-full [&_img]:object-contain">
                          <MarkdownRenderer content={todo.description} variant="muted" />
                        </div>
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
                        <Badge variant="outline" className="max-w-full min-w-0 gap-1">
                          {todo.scopeKind === 'user' ? <Globe2 className="h-3 w-3 shrink-0" /> : <FolderKanban className="h-3 w-3 shrink-0" />}
                          <span className="min-w-0 truncate">{formatTodoScope(todo)}</span>
                        </Badge>
                        {todo.dueAt && (
                          <Badge variant={isOverdue(todo) ? 'destructive' : 'outline'} className="gap-1">
                            <CalendarDays className="h-3 w-3" />
                            {formatDate(todo.dueAt, locale)}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t('actions.todoActions')} disabled={bulk.busy}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {todo.status === 'archived' ? (
                          <DropdownMenuItem disabled={!todo.canWrite} onSelect={() => void restoreTodo(todo)}>
                            <RefreshCcw className="h-4 w-4" />
                            {t('actions.restore')}
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem disabled={!todo.canWrite} onSelect={() => void toggleDone(todo)}>
                              {todo.status === 'done' ? <RefreshCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                              {todo.status === 'done' ? t('actions.reopen') : t('actions.completeQuick')}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!todo.canWrite} onSelect={() => openEditDialog(todo)}>
                              <Edit3 className="h-4 w-4" />
                              {t('actions.edit')}
                            </DropdownMenuItem>
                            {todo.readState === 'unread' && (
                              <DropdownMenuItem onSelect={() => void updateTodo(todo.id, { markSeen: true })}>
                                <Check className="h-4 w-4" />
                                {t('actions.markSeen')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem variant="destructive" disabled={!todo.canWrite} onSelect={() => void archiveTodo(todo)}>
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

        <aside className="hidden min-h-0 min-w-0 md:block md:overflow-y-auto md:overscroll-contain">
          <div data-testid="todo-detail" className="min-w-0 overflow-hidden rounded-md border border-border bg-background p-4 xl:sticky xl:top-0">
            <TodoDetailPanel
              todo={selectedTodo}
              locale={locale}
              followUpComment={followUpComment}
              isMutating={isMutating || bulk.busy}
              isSendingFollowUp={isSendingFollowUp}
              formatCategoryName={formatCategoryName}
              onEdit={openEditDialog}
              onArchive={archiveTodo}
              onRestore={restoreTodo}
              onToggleDone={toggleDone}
              onMarkSeen={(todoId) => updateTodo(todoId, { markSeen: true })}
              onOpenSession={openTodoSession}
              onUpdateFollowUpComment={updateFollowUpComment}
              onSendFollowUp={sendTodoFollowUp}
            />
          </div>
        </aside>
      </div>

      <Dialog
        open={detailDialogOpen && isMobileDetailViewport && Boolean(selectedTodo)}
        onOpenChange={setDetailDialogOpen}
      >
        <DialogContent layout="viewport" className="md:hidden">
          <DialogHeader className="shrink-0 border-b px-4 pt-5 pb-4 pr-12 text-left">
            <DialogTitle>{t('detail.dialogTitle')}</DialogTitle>
            <DialogDescription className="truncate">
              {selectedTodo?.title ?? t('states.noSelectionTitle')}
            </DialogDescription>
          </DialogHeader>
          <div data-testid="todo-detail-dialog" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <TodoDetailPanel
              todo={selectedTodo}
              locale={locale}
              followUpComment={followUpComment}
              isMutating={isMutating || bulk.busy}
              isSendingFollowUp={isSendingFollowUp}
              showEmptyState={false}
              formatCategoryName={formatCategoryName}
              onEdit={openEditDialog}
              onArchive={archiveTodo}
              onRestore={restoreTodo}
              onToggleDone={toggleDone}
              onMarkSeen={(todoId) => updateTodo(todoId, { markSeen: true })}
              onOpenSession={openTodoSession}
              onUpdateFollowUpComment={updateFollowUpComment}
              onSendFollowUp={sendTodoFollowUp}
            />
          </div>
        </DialogContent>
      </Dialog>

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
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {t('sections.workspace')}
                </h3>
                {renderWorkspaceFilters(true)}
              </section>

              <section className="mt-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {t('sections.status')}
                </h3>
                <Badge variant="outline">{visibleUnreadCount > 99 ? '99+' : visibleUnreadCount}</Badge>
              </div>
              {renderStatusFilters(true)}
            </section>

            <section className="mt-5 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('sections.readState')}
              </h3>
              {renderReadStateFilters(true)}
            </section>

            <section className="mt-5 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('sections.priority')}
              </h3>
              {renderPriorityFilters(true)}
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
            <TodoEditorFields
              form={form}
              onChange={setForm}
              categories={categories}
              assignees={assignees}
              selectedCategory={editingTodo?.category}
              selectedAssignee={editingTodo?.assignee}
              formatCategoryName={formatCategoryName}
              fileQuery={fileQuery}
              onFileQueryChange={setFileQuery}
              fileResults={fileResults}
              isFileSearching={isFileSearching}
              onAddFile={addFileLink}
              onRemoveFile={removeFileLink}
              scopeContent={(
                <div className="rounded-md border border-border bg-muted/35 px-3 py-3">
                  <div className="flex items-start gap-3">
                    {editingTodoId
                      ? editingTodo?.scopeKind === 'user'
                        ? <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        : <FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      : selectedWorkspaceId
                        ? <FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        : <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('fields.workspace')}</p>
                      <p className="mt-1 truncate text-sm font-medium">
                        {editingTodoId && editingTodo ? formatTodoScope(editingTodo) : selectedWorkspaceLabel}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t(editingTodoId ? 'editor.scopeLocked' : 'editor.scopeHint')}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            />
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
