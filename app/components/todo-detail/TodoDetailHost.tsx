'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Archive, Check, ExternalLink, Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { authClient } from '@/app/lib/auth-client';
import { Link, useRouter } from '@/i18n/navigation';
import { TodoDetailPanel } from '@/app/apps/todos/components/TodoDetailPanel';
import { TodoEditorFields } from '@/app/apps/todos/components/TodoEditorFields';
import { TodoIcon, resolvedTodoIconKey, todoFormPayload, todoToForm } from '@/app/lib/todos/client-presentation';
import type { AssigneeOption, TodoCategory, TodoFormState, TodoItem } from '@/app/lib/todos/client-types';
import { loadTodoEditorOptions } from '@/app/lib/todos/client';
import { buildTodoPageHref, isUnmodifiedPrimaryClick, todoIdFromHref, todoIdFromSearchParams } from '@/app/lib/todos/navigation';
import { getDefaultTodoCategoryKey } from '@/app/lib/todos/default-categories';
import { listWorkspaceFileReferences, type WorkspaceFileReferenceEntry } from '@/app/lib/files/client';
import { dispatchOpenChatSession } from '@/app/lib/chat/open-chat-session-event';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cancelTodoPendingAction, closeTodoDetail, discardTodoDraft, followUpTodoDetail, mutateTodoDetail,
  openTodoDetail, reloadTodoDetail, useTodoDetailStore } from '@/app/store/todo-detail-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

function TodoPopupContent({ todo }: { todo: TodoItem }) {
  const t = useTranslations('todos');
  const locale = useLocale();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const state = useTodoDetailStore();
  const [form, setForm] = useState<TodoFormState | null>(null);
  const [options, setOptions] = useState<{ categories: TodoCategory[]; assignees: AssigneeOption[] } | null>(null);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [files, setFiles] = useState<WorkspaceFileReferenceEntry[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [followUp, setFollowUp] = useState(todo.completionComment || '');
  const personalWorkspace = useWorkspaceStore((workspaceState) => workspaceState.workspaces.find((workspace) => workspace.type === 'personal')?.id);
  const fileWorkspaceId = todo.workspaceId || personalWorkspace;
  const editing = form !== null;
  const baseline = useRef(todoToForm(todo));
  const formatCategoryName = useCallback((category: Pick<TodoCategory, 'name' | 'icon'> | null | undefined) => {
    const defaultKey = category ? getDefaultTodoCategoryKey(category) : null;
    return defaultKey ? t(`defaultCategories.${defaultKey}`) : category?.name || t('filters.noCategory');
  }, [t]);

  useEffect(() => {
    if (!editing) return;
    const abort = new AbortController();
    void loadTodoEditorOptions(todo, abort.signal, session?.user).then((next) => {
      if (!abort.signal.aborted) { setOptions(next); setEditorError(null); }
    }).catch((error) => {
      if (!abort.signal.aborted) setEditorError(error instanceof Error ? error.message : t('errors.loadFailed'));
    });
    return () => abort.abort();
  }, [editing, todo, t, session?.user, optionsRetry]);

  useEffect(() => {
    if (!editing || !fileWorkspaceId) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setFileLoading(true);
      void listWorkspaceFileReferences({ workspaceId: fileWorkspaceId, query: fileQuery.trim(), limit: 30, signal: abort.signal, cache: 'no-store' })
        .then((result) => { if (!abort.signal.aborted) setFiles(result); })
        .catch((error) => { if (!abort.signal.aborted) setEditorError(error instanceof Error ? error.message : t('errors.loadFailed')); })
        .finally(() => { if (!abort.signal.aborted) setFileLoading(false); });
    }, 200);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [editing, fileQuery, fileWorkspaceId, t]);

  const updateForm = (next: TodoFormState) => {
    setForm(next);
    useTodoDetailStore.setState({ dirty: JSON.stringify(next) !== JSON.stringify(baseline.current) });
  };
  const openSession = (target: Pick<TodoItem, 'id' | 'sourceSessionId' | 'workspaceId'>) => {
    if (!target.sourceSessionId || state.busy || state.dirty) return;
    closeTodoDetail();
    if (!dispatchOpenChatSession(target.sourceSessionId, 'todo', target.workspaceId)) {
      router.push(buildChatSessionHref('/notebook', target.sourceSessionId, target.workspaceId));
    }
  };
  const save = async () => {
    if (!form || !form.title.trim()) { setEditorError(t('errors.titleRequired')); return; }
    try {
      await mutateTodoDetail(todoFormPayload(form, todo));
    } catch (error) { setEditorError(error instanceof Error ? error.message : t('errors.saveFailed')); }
  };
  const cancelEditing = () => {
    if (state.dirty) { useTodoDetailStore.setState({ pendingAction: { kind: 'reload' } }); return; }
    setForm(null); setEditorError(null); useTodoDetailStore.setState({ error: null, errorStatus: null });
  };

  return <>
    <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left sm:px-6 sm:pr-12">
      <DialogTitle className="flex min-w-0 items-start gap-3 text-lg leading-snug sm:text-xl">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><TodoIcon iconKey={resolvedTodoIconKey(todo)} className="size-5" /></span>
        <span className="min-w-0 self-center break-words">{editing ? t('editor.editTitle') : todo.title}</span>
      </DialogTitle>
      <DialogDescription className={editing ? undefined : 'sr-only'}>{editing ? t('editor.scopeLocked') : t('popup.description')}</DialogDescription>
    </DialogHeader>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
      {state.error && <div role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{state.errorStatus === 409 ? t('popup.conflict') : state.error}</p>
        <Button data-testid="todo-popup-retry" size="sm" variant="outline" className="mt-2" disabled={state.busy} onClick={() => void reloadTodoDetail()}>
          <RefreshCw className="size-4" />{t('popup.reload')}
        </Button>
      </div>}
      {editing && form ? <>
        {editorError && <div role="alert" className="mb-4 text-sm text-destructive"><p>{editorError}</p>
          {!options && <Button size="sm" variant="outline" className="mt-2" onClick={() => { setEditorError(null); setOptionsRetry((count) => count + 1); }}><RefreshCw className="size-4" />{t('popup.retry')}</Button>}
        </div>}
        {!options && !editorError && <p role="status" className="mb-4 text-sm text-muted-foreground">{t('popup.loadingOptions')}</p>}
        <fieldset disabled={state.busy} className="min-w-0">
          <TodoEditorFields compact form={form} onChange={updateForm} categories={options?.categories || []} assignees={options?.assignees || []}
            selectedCategory={todo.category} selectedAssignee={todo.assignee} formatCategoryName={formatCategoryName}
            fileQuery={fileQuery} onFileQueryChange={setFileQuery} fileResults={files} isFileSearching={fileLoading}
            onAddFile={(file) => { if (file.type === 'file' && !form.fileLinks.some((link) => link.workspacePath === file.path)) updateForm({ ...form, fileLinks: [...form.fileLinks, { workspacePath: file.path, label: null }] }); }}
            onRemoveFile={(path) => updateForm({ ...form, fileLinks: form.fileLinks.filter((link) => link.workspacePath !== path) })}
            scopeContent={<div className="rounded-md border bg-muted/30 p-3 text-sm"><span className="text-muted-foreground">{t('fields.workspace')}: </span>{todo.workspace?.name || t('scope.user')}</div>} />
        </fieldset>
      </> : <>
        {!todo.canWrite && <p className="mb-4 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{t('popup.readOnly')}</p>}
        <TodoDetailPanel todo={todo} locale={locale} hideTitle hideActions showEmptyState={false}
          navigationDisabled={state.busy || state.dirty}
          followUpComment={followUp} isMutating={state.busy} isSendingFollowUp={state.busy}
          formatCategoryName={formatCategoryName} onEdit={() => setForm(todoToForm(todo))}
          onRestore={() => { void mutateTodoDetail({ status: 'open', markSeen: true }); }}
          onToggleDone={() => { void mutateTodoDetail({ status: todo.status === 'done' ? 'open' : 'done', markSeen: true }); }}
          onMarkSeen={() => mutateTodoDetail({ markSeen: true })} onOpenSession={openSession}
          onUpdateFollowUpComment={(value) => { setFollowUp(value); useTodoDetailStore.setState({ dirty: value !== (todo.completionComment || '') }); }}
          onSendFollowUp={() => followUpTodoDetail(followUp, locale)} />
      </>}
    </div>
    <DialogFooter className="shrink-0 flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-6">
      {editing ? <div className="flex w-full justify-end gap-2">
        <Button data-testid="todo-popup-cancel-edit" variant="outline" disabled={state.busy} onClick={cancelEditing}>{t('actions.cancel')}</Button>
        <Button data-testid="todo-popup-save" disabled={state.busy || !options || state.errorStatus === 409 || !form?.title.trim()} onClick={() => void save()}>
          {state.busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{t('actions.save')}
        </Button>
      </div> : <>
        <Button asChild variant="link" className="self-start px-0 text-muted-foreground" disabled={state.busy || state.dirty}>
          <Link data-testid="todo-popup-full-page" href={buildTodoPageHref(todo.id, todo.workspaceId)}
            aria-disabled={state.busy || state.dirty} onClick={(event) => {
              if (state.busy || state.dirty) { event.preventDefault(); return; }
              if (isUnmodifiedPrimaryClick(event)) {
                event.preventDefault();
                const href = buildTodoPageHref(todo.id, todo.workspaceId);
                closeTodoDetail();
                router.push(href);
              }
            }}><ExternalLink className="size-4" />{t('popup.openPage')}</Link>
        </Button>
        {todo.canWrite && <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {todo.status === 'archived'
            ? <Button data-testid="todo-popup-restore" disabled={state.busy} onClick={() => void mutateTodoDetail({ status: 'open', markSeen: true })}><RefreshCw className="size-4" />{t('actions.restore')}</Button>
            : <>
              <Button data-testid="todo-popup-edit" variant="outline" disabled={state.busy || state.dirty} onClick={() => setForm(todoToForm(todo))}><Pencil className="size-4" />{t('actions.edit')}</Button>
              <Button data-testid="todo-popup-archive" variant="ghost" disabled={state.busy || state.dirty} onClick={() => void mutateTodoDetail({ status: 'archived' })}><Archive className="size-4" />{t('actions.archiveTodo')}</Button>
              <Button data-testid={todo.status === 'done' ? 'todo-popup-reopen' : 'todo-popup-complete'} disabled={state.busy || state.dirty}
                onClick={() => void mutateTodoDetail({ status: todo.status === 'done' ? 'open' : 'done', markSeen: true })}>
                {state.busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{t(todo.status === 'done' ? 'actions.reopen' : 'actions.complete')}
              </Button>
            </>}
        </div>}
      </>}
    </DialogFooter>
  </>;
}

export function TodoDetailHost() {
  const t = useTranslations('todos');
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  const state = useTodoDetailStore();
  const todoId = todoIdFromSearchParams(searchParams);
  const lastPath = useRef(pathname);
  const lastUser = useRef<string | null>(null);
  const lastRouteTodo = useRef(todoId);

  useEffect(() => {
    if (isPending) return;
    const userId = session?.user.id || null;
    if (!userId || (lastUser.current && lastUser.current !== userId)) closeTodoDetail(true);
    lastUser.current = userId;
    if (userId && todoId) void openTodoDetail(todoId);
  }, [isPending, session?.user.id, todoId]);

  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      if (!todoId) closeTodoDetail();
    }
  }, [pathname, todoId]);

  useEffect(() => {
    const previous = lastRouteTodo.current;
    lastRouteTodo.current = todoId;
    if (previous && !todoId && useTodoDetailStore.getState().todoId === previous) closeTodoDetail();
  }, [todoId]);

  useEffect(() => {
    if (!session?.user.id) return;
    const openLink = (event: MouseEvent) => {
      if (!isUnmodifiedPrimaryClick(event)) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
      const id = todoIdFromHref(anchor.href, window.location.href);
      if (!id) return;
      event.preventDefault(); void openTodoDetail(id);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!useTodoDetailStore.getState().dirty && !useTodoDetailStore.getState().busy) return;
      event.preventDefault(); event.returnValue = '';
    };
    document.addEventListener('click', openLink);
    window.addEventListener('beforeunload', beforeUnload);
    return () => { document.removeEventListener('click', openLink); window.removeEventListener('beforeunload', beforeUnload); };
  }, [session?.user.id]);

  return <>
    <Dialog open={state.open} onOpenChange={(open) => { if (!open) closeTodoDetail(); }}>
      <DialogContent data-testid="todo-detail-popup" className="flex max-h-[min(90dvh,54rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onEscapeKeyDown={(event) => { if (state.pendingAction || state.busy) event.preventDefault(); }}
        onCloseAutoFocus={(event) => event.preventDefault()}>
        {state.todo && !state.loading ? <TodoPopupContent key={`${state.todo.id}:${state.revision}`} todo={state.todo} /> : <>
          <DialogHeader className="border-b px-5 py-4 pr-12 text-left"><DialogTitle>{t('detail.dialogTitle')}</DialogTitle><DialogDescription>{t('popup.description')}</DialogDescription></DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {state.loading ? <p role="status" className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t('states.loading')}</p>
              : <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{state.errorStatus === 404 || state.errorStatus === 403 ? t('popup.unavailable') : state.error}</p><Button data-testid="todo-popup-retry" className="mt-3" variant="outline" onClick={() => void reloadTodoDetail()}><RefreshCw className="size-4" />{t('popup.retry')}</Button></div>}
          </div>
          <DialogFooter className="border-t p-4"><Button variant="outline" onClick={() => closeTodoDetail()}><X className="size-4" />{t('popup.close')}</Button></DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(state.pendingAction)} onOpenChange={(open) => { if (!open) cancelTodoPendingAction(); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('popup.discardTitle')}</AlertDialogTitle><AlertDialogDescription>{t('popup.discardDescription')}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel onClick={cancelTodoPendingAction}>{t('popup.keepEditing')}</AlertDialogCancel><AlertDialogAction onClick={() => void discardTodoDraft()}>{t('popup.discard')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
