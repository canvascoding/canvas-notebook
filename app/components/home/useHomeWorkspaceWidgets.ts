'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type HomeWidgetAutomation,
  type HomeWidgetEmail,
  type HomeWidgetStudio,
  type HomeWidgetTodo,
} from '@/app/lib/home/workspace-widget-data';

export type HomeWidgetState<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: T;
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
} | {
  status: 'error';
  errorCode: 'source_unavailable';
};

type HomeWorkspaceWidgetResponse = {
  success?: boolean;
  data?: {
    emails: WidgetApiResult<HomeWidgetEmail[]>;
    todos: WidgetApiResult<HomeWidgetTodo[]>;
    automation: WidgetApiResult<HomeWidgetAutomation | null>;
    studio: WidgetApiResult<HomeWidgetStudio | null>;
  };
};

function initialSnapshot(workspaceId: string | null): HomeWorkspaceWidgetSnapshot {
  return {
    workspaceId,
    emails: { status: 'idle', data: [] },
    todos: { status: 'idle', data: [] },
    automation: { status: 'idle', data: null },
    studio: { status: 'idle', data: null },
  };
}

export function useHomeWorkspaceWidgets(workspaceId: string | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<HomeWorkspaceWidgetSnapshot>(() => initialSnapshot(workspaceId ?? null));
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const current = snapshot.workspaceId === (workspaceId ?? null) ? snapshot : initialSnapshot(workspaceId ?? null);

  useEffect(() => {
    if (!active || !workspaceId) return;
    const controller = new AbortController();
    const forceRefresh = revision > 0;

    const loadingTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setSnapshot((previous) => {
        const hasReadyData = previous.workspaceId === workspaceId
          && [previous.emails, previous.todos, previous.automation, previous.studio].some((value) => value.status === 'ready');
        if (hasReadyData) return previous;
        const start = initialSnapshot(workspaceId);
        start.emails.status = 'loading';
        start.todos.status = 'loading';
        start.automation.status = 'loading';
        start.studio.status = 'loading';
        return start;
      });
      const params = new URLSearchParams({ workspaceId, ...(forceRefresh ? { refresh: '1' } : {}) });
      void fetch(`/api/home/workspace-widgets?${params}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      }).then(async (response) => {
        const payload = await response.json().catch(() => null) as HomeWorkspaceWidgetResponse | null;
        if (!response.ok || !payload?.success || !payload.data) throw new Error('Workspace widgets could not be loaded.');
        if (controller.signal.aborted) return;
        const data = payload.data;
        setSnapshot((currentSnapshot) => {
          const previous = currentSnapshot.workspaceId === workspaceId ? currentSnapshot : initialSnapshot(workspaceId);
          return {
            workspaceId,
            emails: data.emails.status === 'ready' ? { status: 'ready', data: data.emails.data } : { status: 'error', data: previous.emails.data },
            todos: data.todos.status === 'ready' ? { status: 'ready', data: data.todos.data } : { status: 'error', data: previous.todos.data },
            automation: data.automation.status === 'ready' ? { status: 'ready', data: data.automation.data } : { status: 'error', data: previous.automation.data },
            studio: data.studio.status === 'ready' ? { status: 'ready', data: data.studio.data } : { status: 'error', data: previous.studio.data },
          };
        });
      }).catch(() => {
        if (controller.signal.aborted) return;
        setSnapshot((previous) => {
          if (previous.workspaceId !== workspaceId) return previous;
          return {
            ...previous,
            emails: previous.emails.status === 'ready' ? previous.emails : { status: 'error', data: previous.emails.data },
            todos: previous.todos.status === 'ready' ? previous.todos : { status: 'error', data: previous.todos.data },
            automation: previous.automation.status === 'ready' ? previous.automation : { status: 'error', data: previous.automation.data },
            studio: previous.studio.status === 'ready' ? previous.studio : { status: 'error', data: previous.studio.data },
          };
        });
      });
    }, 0);

    return () => {
      window.clearTimeout(loadingTimer);
      controller.abort();
    };
  }, [active, revision, workspaceId]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => setRevision((value) => value + 1);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('todo_updated', refresh);
    window.addEventListener('workspace_widgets_updated', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('todo_updated', refresh);
      window.removeEventListener('workspace_widgets_updated', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, workspaceId]);

  return { ...current, retry };
}
