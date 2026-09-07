'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  loadHomeWidgetAutomation,
  loadHomeWidgetEmails,
  loadHomeWidgetStudio,
  loadHomeWidgetTodos,
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
    const start = initialSnapshot(workspaceId);
    start.emails.status = 'loading';
    start.todos.status = 'loading';
    start.automation.status = 'loading';
    start.studio.status = 'loading';
    const update = <K extends keyof Omit<HomeWorkspaceWidgetSnapshot, 'workspaceId'>>(
      key: K,
      value: HomeWorkspaceWidgetSnapshot[K],
    ) => {
      if (controller.signal.aborted) return;
      setSnapshot((previous) => previous.workspaceId === workspaceId ? { ...previous, [key]: value } : previous);
    };
    const settle = <K extends keyof Omit<HomeWorkspaceWidgetSnapshot, 'workspaceId'>>(
      key: K,
      promise: Promise<HomeWorkspaceWidgetSnapshot[K]['data']>,
      emptyValue: HomeWorkspaceWidgetSnapshot[K]['data'],
    ) => {
      void promise.then(
        (data) => update(key, { status: 'ready', data } as HomeWorkspaceWidgetSnapshot[K]),
        () => update(key, { status: 'error', data: emptyValue } as HomeWorkspaceWidgetSnapshot[K]),
      );
    };

    const loadingTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setSnapshot(start);
      settle('emails', loadHomeWidgetEmails(fetch, controller.signal), []);
      settle('todos', loadHomeWidgetTodos(fetch, workspaceId, controller.signal), []);
      settle('automation', loadHomeWidgetAutomation(fetch, workspaceId, controller.signal), null);
      settle('studio', loadHomeWidgetStudio(fetch, workspaceId, controller.signal), null);
    }, 0);

    return () => {
      window.clearTimeout(loadingTimer);
      controller.abort();
    };
  }, [active, revision, workspaceId]);

  return { ...current, retry };
}
