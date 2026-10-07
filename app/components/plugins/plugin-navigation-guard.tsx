'use client';

import { useLayoutEffect, useRef } from 'react';

const HISTORY_KEY = '__canvasPluginNavigation';
type EditorState = { dirty: boolean; pending: boolean | (() => boolean) };
type HistoryPosition = { group: string; index: number };
const editors = new Map<symbol, EditorState>();
let unsavedChangesMessage = 'Discard unsaved changes?';

function isEditorPending(editor: EditorState): boolean {
  return typeof editor.pending === 'function' ? editor.pending() : editor.pending;
}

/** OAuth must start from a clean state; accepting a discard dialog grants no write authority. */
export function hasPluginNavigationBlockers(): boolean {
  return [...editors.values()].some(editor => editor.dirty || isEditorPending(editor));
}

export function confirmPluginNavigation(): boolean {
  if ([...editors.values()].some(isEditorPending)) return false;
  return ![...editors.values()].some(editor => editor.dirty) || window.confirm(unsavedChangesMessage);
}

export function usePluginEditorNavigationGuard({ dirty, pending }: EditorState): void {
  const key = useRef(Symbol('plugin-editor'));
  useLayoutEffect(() => { editors.set(key.current, { dirty, pending }); }, [dirty, pending]);
  useLayoutEffect(() => {
    const registration = key.current;
    return () => { editors.delete(registration); };
  }, []);
}

function positionOf(state: unknown): HistoryPosition | null {
  if (!state || typeof state !== 'object') return null;
  const position = Reflect.get(state, HISTORY_KEY);
  return position && typeof position.group === 'string' && Number.isSafeInteger(position.index)
    ? position as HistoryPosition : null;
}

function stateWithPosition(state: unknown, position: HistoryPosition): Record<string, unknown> {
  return { ...(state && typeof state === 'object' ? state : {}), [HISTORY_KEY]: position };
}

function browserEntryIndex(): number | null {
  const navigation = Reflect.get(window, 'navigation');
  const index = navigation?.currentEntry?.index;
  return typeof index === 'number' && Number.isSafeInteger(index) ? index : null;
}

export function PluginNavigationGuard({ unsavedChangesMessage: message }: { unsavedChangesMessage: string }) {
  useLayoutEffect(() => { unsavedChangesMessage = message; }, [message]);
  useLayoutEffect(() => {
    const history = window.history;
    const originalPush = history.pushState, originalReplace = history.replaceState;
    let position = positionOf(history.state) || { group: crypto.randomUUID(), index: 0 };
    let entryIndex = browserEntryIndex();
    let href = window.location.href;
    let restoring = false, active = true, approvedUnload = false;
    let approvedUnloadTimer: ReturnType<typeof setTimeout> | undefined;
    originalReplace.call(history, stateWithPosition(history.state, position), '', href);

    const push: History['pushState'] = function (data, unused, url) {
      if (!active) return originalPush.call(history, data, unused, url);
      const next = { group: position.group, index: position.index + 1 };
      originalPush.call(history, stateWithPosition(data, next), unused, url);
      position = next; href = window.location.href; entryIndex = browserEntryIndex();
    };
    const replace: History['replaceState'] = function (data, unused, url) {
      originalReplace.call(history, active ? stateWithPosition(data, position) : data, unused, url);
      if (active) { href = window.location.href; entryIndex = browserEntryIndex(); }
    };
    history.pushState = push; history.replaceState = replace;

    const restore = (target: HistoryPosition | null) => {
      const actualIndex = browserEntryIndex();
      const delta = entryIndex !== null && actualIndex !== null ? entryIndex - actualIndex
        : target?.group === position.group ? position.index - target.index : 1;
      if (delta !== 0) history.go(delta);
    };
    const fromHistory = (event: PopStateEvent) => {
      const target = positionOf(event.state);
      if (restoring) {
        event.stopImmediatePropagation();
        if (window.location.href === href && target?.group === position.group && target.index === position.index) restoring = false;
        else restore(target);
        return;
      }
      if (!confirmPluginNavigation()) {
        event.stopImmediatePropagation();
        restoring = true; restore(target);
        return;
      }
      position = target || { group: position.group, index: position.index - 1 };
      href = window.location.href; entryIndex = browserEntryIndex();
      if (!target) originalReplace.call(history, stateWithPosition(history.state, position), '', href);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (approvedUnload) { approvedUnload = false; return; }
      if (![...editors.values()].some(editor => editor.dirty || isEditorPending(editor))) return;
      event.preventDefault(); event.returnValue = '';
    };
    const fromLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!target || target.hasAttribute('download') || target.target && target.target !== '_self') return;
      const destination = new URL(target.href, window.location.href);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.href === window.location.href) return;
      if (!confirmPluginNavigation()) { event.preventDefault(); event.stopImmediatePropagation(); }
      else {
        approvedUnload = true;
        clearTimeout(approvedUnloadTimer);
        approvedUnloadTimer = setTimeout(() => { approvedUnload = false; }, 0);
      }
    };
    window.addEventListener('popstate', fromHistory, true);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', fromLink, true);
    return () => {
      active = false;
      clearTimeout(approvedUnloadTimer);
      window.removeEventListener('popstate', fromHistory, true);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', fromLink, true);
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
    };
  }, []);
  return null;
}
