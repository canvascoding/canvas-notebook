'use client';

import { create } from 'zustand';
import type { TodoItem } from '@/app/lib/todos/client-types';
import { loadTodoDetail, patchTodoDetail, sendTodoDetailFollowUp, TodoClientError } from '@/app/lib/todos/client';

type PendingAction = { kind: 'close' } | { kind: 'open'; todoId: string } | { kind: 'reload' };
type State = {
  open: boolean;
  todoId: string | null;
  todo: TodoItem | null;
  loading: boolean;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  errorStatus: number | null;
  pendingAction: PendingAction | null;
  revision: number;
};
const initialState: State = { open: false, todoId: null, todo: null, loading: false, busy: false, dirty: false,
  error: null, errorStatus: null, pendingAction: null, revision: 0 };
export const useTodoDetailStore = create<State>(() => initialState);
let generation = 0;
let controller: AbortController | null = null;
let opener: HTMLElement | null = null;

export function notifyTodoUpdated(todoId: string) {
  window.dispatchEvent(new CustomEvent('todo_updated', { detail: { todoId } }));
  window.dispatchEvent(new CustomEvent('notification_summary_updated'));
}

function clearTodoLocation(todoId: string | null) {
  const url = new URL(window.location.href);
  if (!todoId || url.searchParams.get('todo') !== todoId || url.searchParams.get('todoView') === 'page') return;
  url.searchParams.delete('todo');
  url.searchParams.delete('todoView');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export async function reloadTodoDetail() {
  const state = useTodoDetailStore.getState();
  if (!state.todoId || state.busy) return;
  if (state.dirty) { useTodoDetailStore.setState({ pendingAction: { kind: 'reload' } }); return; }
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  useTodoDetailStore.setState({ loading: true, error: null, errorStatus: null });
  try {
    const todo = await loadTodoDetail(state.todoId, controller.signal);
    if (current !== generation) return;
    if (current === generation) useTodoDetailStore.setState((latest) => ({ todo, loading: false, revision: latest.revision + 1 }));
  } catch (error) {
    if (current !== generation) return;
    useTodoDetailStore.setState({ todo: null, loading: false, error: error instanceof Error ? error.message : 'Unable to load this to-do.',
      errorStatus: error instanceof TodoClientError ? error.status : null });
  }
}

export async function openTodoDetail(todoId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(todoId)) return;
  const state = useTodoDetailStore.getState();
  if (state.busy || (state.open && state.todoId === todoId)) return;
  if (state.open && state.dirty) { useTodoDetailStore.setState({ pendingAction: { kind: 'open', todoId } }); return; }
  if (state.open) clearTodoLocation(state.todoId);
  if (!state.open) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  useTodoDetailStore.setState({ ...initialState, open: true, todoId });
  await reloadTodoDetail();
}

export function closeTodoDetail(force = false) {
  const state = useTodoDetailStore.getState();
  if (state.busy && !force) return;
  if (state.dirty && !force) { useTodoDetailStore.setState({ pendingAction: { kind: 'close' } }); return; }
  ++generation;
  controller?.abort(); controller = null;
  useTodoDetailStore.setState(initialState);
  clearTodoLocation(state.todoId);
  const focusTarget = opener; opener = null;
  window.requestAnimationFrame(() => { if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true }); });
}

export function cancelTodoPendingAction() { useTodoDetailStore.setState({ pendingAction: null }); }
export async function discardTodoDraft() {
  const { pendingAction } = useTodoDetailStore.getState();
  useTodoDetailStore.setState({ dirty: false, pendingAction: null });
  if (pendingAction?.kind === 'open') await openTodoDetail(pendingAction.todoId);
  else if (pendingAction?.kind === 'reload') await reloadTodoDetail();
  else closeTodoDetail();
}

export async function mutateTodoDetail(payload: Record<string, unknown>) {
  const state = useTodoDetailStore.getState();
  if (!state.todo || state.busy || state.loading) return null;
  if (!state.todo.canWrite) return null;
  const current = generation;
  useTodoDetailStore.setState({ busy: true, error: null, errorStatus: null });
  try {
    const todo = await patchTodoDetail(state.todo, payload);
    notifyTodoUpdated(todo.id);
    if (current === generation) useTodoDetailStore.setState((latest) => ({ todo, busy: false, dirty: false, revision: latest.revision + 1 }));
    return todo;
  } catch (error) {
    if (current === generation) useTodoDetailStore.setState({ busy: false, error: error instanceof Error ? error.message : 'Unable to save this to-do.',
      errorStatus: error instanceof TodoClientError ? error.status : null });
    return null;
  }
}

export async function followUpTodoDetail(comment: string, locale: string) {
  const state = useTodoDetailStore.getState();
  if (!state.todo?.canWrite || state.busy || state.todo.status !== 'done') return;
  const current = generation;
  useTodoDetailStore.setState({ busy: true, error: null, errorStatus: null });
  try {
    const todo = await sendTodoDetailFollowUp(state.todo, comment, locale);
    notifyTodoUpdated(todo.id);
    if (current === generation) useTodoDetailStore.setState((latest) => ({ todo, busy: false, dirty: false, revision: latest.revision + 1 }));
  } catch (error) {
    if (current === generation) useTodoDetailStore.setState({ busy: false, error: error instanceof Error ? error.message : 'Unable to notify the agent.',
      errorStatus: error instanceof TodoClientError ? error.status : null });
  }
}
