'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { readTodoAppData, type TodoAppData } from '@/app/lib/tool-apps/todo-data';
import { loadTodoDetail } from '@/app/lib/todos/client';
import { buildTodoPopupHref, isUnmodifiedPrimaryClick } from '@/app/lib/todos/navigation';
import { openTodoDetail } from '@/app/store/todo-detail-store';

export function TodoAppActions({ data, update, refresh }: {
  data: TodoAppData;
  update: (data: Record<string, unknown>) => void;
  refresh: () => void;
}) {
  const t = useTranslations('chat.toolApp');
  const updateRef = useRef(update);
  useEffect(() => { updateRef.current = update; }, [update]);

  useEffect(() => {
    let generation = 0;
    let disposed = false;
    let request: AbortController | null = null;
    const onTodoUpdated = (event: Event) => {
      const changedId = (event as CustomEvent<{ todoId?: string }>).detail?.todoId;
      if (changedId && changedId !== data.id) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const currentGeneration = ++generation;
      void loadTodoDetail(data.id, controller.signal).then((todo) => {
        if (disposed || controller.signal.aborted || currentGeneration !== generation || todo.id !== data.id) return;
        const next = readTodoAppData({ id: todo.id, title: todo.title, status: todo.status, priority: todo.priority,
          category: todo.category?.name?.slice(0, 120) || null, assignee: todo.assignee?.name?.slice(0, 160) || null,
          dueAt: todo.dueAt, updatedAt: todo.updatedAt });
        if (next?.id === data.id) updateRef.current(next);
      }).catch(() => {
        // Preserve the current widget and its trigger; manual reload remains available.
      }).finally(() => { if (request === controller) request = null; });
    };
    window.addEventListener('todo_updated', onTodoUpdated);
    return () => {
      disposed = true;
      generation++;
      request?.abort();
      window.removeEventListener('todo_updated', onTodoUpdated);
    };
  }, [data.id]);

  return <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
    <Button size="xs" variant="outline" asChild><Link href={buildTodoPopupHref(data.id)} onClick={(event) => {
      if (!isUnmodifiedPrimaryClick(event)) return;
      event.preventDefault();
      openTodoDetail(data.id);
    }}>
      {t(data.status === 'open' ? 'todoReview' : 'open')}
    </Link></Button>
    <Button size="xs" variant="ghost" onClick={refresh}>{t('reload')}</Button>
  </div>;
}
