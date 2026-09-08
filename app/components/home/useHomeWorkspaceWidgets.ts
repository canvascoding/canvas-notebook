'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { HomeWidgetEmailCacheMetadata } from '@/app/lib/home/workspace-email-widget';
import {
  type HomeWidgetAutomation,
  type HomeWidgetEmail,
  type HomeWidgetStudio,
  type HomeWidgetTodo,
} from '@/app/lib/home/workspace-widget-data';
import {
  HOME_WIDGET_NAMES,
  isHomeWidgetName,
  type HomeWidgetName,
} from '@/app/lib/home/workspace-widget-request';

export const HOME_EMAIL_STALE_FOLLOW_UP_MS = 500;
export const HOME_EMAIL_STALE_FOLLOW_UP_MAX_DELAY_MS = 4_000;

export function homeEmailStaleFollowUpDelay(attempt: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt) - 1), 3);
  return Math.min(
    HOME_EMAIL_STALE_FOLLOW_UP_MS * (2 ** exponent),
    HOME_EMAIL_STALE_FOLLOW_UP_MAX_DELAY_MS,
  );
}

export type HomeWidgetState<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: T;
  cachedAt?: string;
  stale?: boolean;
  cache?: HomeWidgetEmailCacheMetadata;
};

type HomeWorkspaceWidgetSnapshot = {
  workspaceId: string | null;
  emails: HomeWidgetState<HomeWidgetEmail[]>;
  todos: HomeWidgetState<HomeWidgetTodo[]>;
  automation: HomeWidgetState<HomeWidgetAutomation | null>;
  studio: HomeWidgetState<HomeWidgetStudio | null>;
};

type WidgetApiResult<T> = {
  status: 'ready';
  data: T;
  cachedAt: string;
  stale: boolean;
  cache?: HomeWidgetEmailCacheMetadata;
} | {
  status: 'error';
  errorCode: 'source_unavailable';
};

type HomeWorkspaceWidgetResponse = {
  success?: boolean;
  data?: {
    emails?: WidgetApiResult<HomeWidgetEmail[]>;
    todos?: WidgetApiResult<HomeWidgetTodo[]>;
    automation?: WidgetApiResult<HomeWidgetAutomation | null>;
    studio?: WidgetApiResult<HomeWidgetStudio | null>;
  };
};

type LoadWidgetOptions = {
  allowEmailFollowUp?: boolean;
  background?: boolean;
  emailFollowUpAttempt?: number;
  emailFollowUpToken?: string;
  force?: boolean;
};

type LoadWidgets = (widgets: readonly HomeWidgetName[], options?: LoadWidgetOptions) => Promise<void>;

function initialSnapshot(workspaceId: string | null): HomeWorkspaceWidgetSnapshot {
  return {
    workspaceId,
    emails: { status: 'idle', data: [] },
    todos: { status: 'idle', data: [] },
    automation: { status: 'idle', data: null },
    studio: { status: 'idle', data: null },
  };
}

function loadingGate<T>(state: HomeWidgetState<T>): HomeWidgetState<T> {
  return state.status === 'ready' ? state : { ...state, status: 'loading' };
}

function failedState<T>(state: HomeWidgetState<T>): HomeWidgetState<T> {
  return state.status === 'ready' ? state : { ...state, status: 'error' };
}

function resultState<T>(
  previous: HomeWidgetState<T>,
  result: WidgetApiResult<T> | undefined,
): HomeWidgetState<T> {
  if (!result || result.status === 'error') return failedState(previous);
  return {
    status: 'ready',
    data: result.data,
    cachedAt: result.cachedAt,
    stale: result.stale,
    ...(result.cache ? { cache: result.cache } : {}),
  };
}

function eventWidgetSelection(event: Event): HomeWidgetName[] {
  if (!(event instanceof CustomEvent) || !Array.isArray(event.detail?.widgets)) return [...HOME_WIDGET_NAMES];
  const selected = event.detail.widgets.filter(isHomeWidgetName);
  return selected.length > 0 ? HOME_WIDGET_NAMES.filter((name) => selected.includes(name)) : [...HOME_WIDGET_NAMES];
}

export function useHomeWorkspaceWidgets(workspaceId: string | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<HomeWorkspaceWidgetSnapshot>(() => initialSnapshot(workspaceId ?? null));
  const requestGenerationRef = useRef<Record<HomeWidgetName, number>>({ emails: 0, todos: 0, automation: 0, studio: 0 });
  const activeControllersRef = useRef(new Set<AbortController>());
  const emailFollowUpTimersRef = useRef(new Map<string, number>());
  const loadWidgetsRef = useRef<LoadWidgets>(async () => undefined);
  const current = snapshot.workspaceId === (workspaceId ?? null) ? snapshot : initialSnapshot(workspaceId ?? null);
  const currentSnapshotRef = useRef(current);

  useEffect(() => {
    currentSnapshotRef.current = current;
  }, [current]);

  const loadWidgets = useCallback<LoadWidgets>(async (widgets, options = {}) => {
    if (!active || !workspaceId) return;
    const requested = HOME_WIDGET_NAMES.filter((name) => widgets.includes(name));
    if (requested.length === 0) return;
    const requestWorkspaceId = workspaceId;
    const generations = new Map<HomeWidgetName, number>();
    for (const widget of requested) {
      const generation = requestGenerationRef.current[widget] + 1;
      requestGenerationRef.current[widget] = generation;
      generations.set(widget, generation);
    }
    if (requested.includes('emails')) {
      for (const timer of emailFollowUpTimersRef.current.values()) window.clearTimeout(timer);
      emailFollowUpTimersRef.current.clear();
    }
    const isCurrent = (widget: HomeWidgetName) => requestGenerationRef.current[widget] === generations.get(widget);
    const controller = new AbortController();
    activeControllersRef.current.add(controller);

    if (!options.background) {
      setSnapshot((previous) => {
        const base = previous.workspaceId === requestWorkspaceId ? previous : initialSnapshot(requestWorkspaceId);
        return {
          ...base,
          emails: requested.includes('emails') ? loadingGate(base.emails) : base.emails,
          todos: requested.includes('todos') ? loadingGate(base.todos) : base.todos,
          automation: requested.includes('automation') ? loadingGate(base.automation) : base.automation,
          studio: requested.includes('studio') ? loadingGate(base.studio) : base.studio,
        };
      });
    }

    const params = new URLSearchParams({ workspaceId: requestWorkspaceId, widgets: requested.join(',') });
    if (options.force) params.set('refresh', requested.join(','));
    try {
      const response = await fetch(`/api/home/workspace-widgets?${params}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as HomeWorkspaceWidgetResponse | null;
      if (!response.ok || !payload?.success || !payload.data) throw new Error('Workspace widgets could not be loaded.');
      if (controller.signal.aborted) return;
      const data = payload.data;
      setSnapshot((previous) => {
        if (previous.workspaceId !== requestWorkspaceId) return previous;
        return {
          ...previous,
          emails: requested.includes('emails') && isCurrent('emails') ? resultState(previous.emails, data.emails) : previous.emails,
          todos: requested.includes('todos') && isCurrent('todos') ? resultState(previous.todos, data.todos) : previous.todos,
          automation: requested.includes('automation') && isCurrent('automation') ? resultState(previous.automation, data.automation) : previous.automation,
          studio: requested.includes('studio') && isCurrent('studio') ? resultState(previous.studio, data.studio) : previous.studio,
        };
      });

      const emailResult = data.emails;
      const emailCache = emailResult?.status === 'ready' ? emailResult.cache : undefined;
      const shouldFollowUpEmail = (
        requested.includes('emails')
        && isCurrent('emails')
        && options.allowEmailFollowUp !== false
        && emailCache?.state === 'stale'
        && emailCache.refreshQueued
        && emailCache.refreshToken
      );
      if (shouldFollowUpEmail) {
        const followUpKey = `${requestWorkspaceId}\0${emailCache.refreshToken}`;
        const attempts = options.emailFollowUpToken === emailCache.refreshToken
          ? Math.max(0, options.emailFollowUpAttempt ?? 0)
          : 0;
        if (!emailFollowUpTimersRef.current.has(followUpKey)) {
          const nextAttempt = attempts + 1;
          const timer = window.setTimeout(() => {
            emailFollowUpTimersRef.current.delete(followUpKey);
            const latest = currentSnapshotRef.current;
            if (
              requestGenerationRef.current.emails !== generations.get('emails')
              || latest.workspaceId !== requestWorkspaceId
              || latest.emails.cache?.refreshToken !== emailCache.refreshToken
              || latest.emails.cache.state !== 'stale'
              || !latest.emails.cache.refreshQueued
            ) return;
            void loadWidgetsRef.current(['emails'], {
              allowEmailFollowUp: true,
              background: true,
              emailFollowUpAttempt: nextAttempt,
              emailFollowUpToken: emailCache.refreshToken,
            });
          }, homeEmailStaleFollowUpDelay(nextAttempt));
          emailFollowUpTimersRef.current.set(followUpKey, timer);
        }
      } else if (requested.includes('emails') && isCurrent('emails')) {
        for (const timer of emailFollowUpTimersRef.current.values()) window.clearTimeout(timer);
        emailFollowUpTimersRef.current.clear();
      }
    } catch {
      if (controller.signal.aborted) return;
      setSnapshot((previous) => {
        if (previous.workspaceId !== requestWorkspaceId) return previous;
        return {
          ...previous,
          emails: requested.includes('emails') && isCurrent('emails') ? failedState(previous.emails) : previous.emails,
          todos: requested.includes('todos') && isCurrent('todos') ? failedState(previous.todos) : previous.todos,
          automation: requested.includes('automation') && isCurrent('automation') ? failedState(previous.automation) : previous.automation,
          studio: requested.includes('studio') && isCurrent('studio') ? failedState(previous.studio) : previous.studio,
        };
      });
    } finally {
      activeControllersRef.current.delete(controller);
    }
  }, [active, workspaceId]);
  useEffect(() => {
    loadWidgetsRef.current = loadWidgets;
  }, [loadWidgets]);

  const retry = useCallback((widget?: HomeWidgetName) => {
    void loadWidgets(widget ? [widget] : HOME_WIDGET_NAMES, { allowEmailFollowUp: true, force: true });
  }, [loadWidgets]);

  useEffect(() => {
    if (!active || !workspaceId) return;
    const controllers = activeControllersRef.current;
    const followUpTimers = emailFollowUpTimersRef.current;
    const initialTimer = window.setTimeout(() => {
      void loadWidgets(HOME_WIDGET_NAMES, { allowEmailFollowUp: true });
    }, 0);
    return () => {
      window.clearTimeout(initialTimer);
      for (const controller of controllers) controller.abort();
      controllers.clear();
      for (const timer of followUpTimers.values()) window.clearTimeout(timer);
      followUpTimers.clear();
    };
  }, [active, loadWidgets, workspaceId]);

  useEffect(() => {
    if (!active) return;
    const refreshTodos = () => {
      void loadWidgets(['todos'], { background: true, force: true });
    };
    const refreshWidgets = (event: Event) => {
      void loadWidgets(eventWidgetSelection(event), { allowEmailFollowUp: true, background: true, force: true });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void loadWidgets(HOME_WIDGET_NAMES, { allowEmailFollowUp: true, background: true });
      }
    };
    window.addEventListener('todo_updated', refreshTodos);
    window.addEventListener('workspace_widgets_updated', refreshWidgets);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('todo_updated', refreshTodos);
      window.removeEventListener('workspace_widgets_updated', refreshWidgets);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, loadWidgets]);

  return { ...current, retry };
}
