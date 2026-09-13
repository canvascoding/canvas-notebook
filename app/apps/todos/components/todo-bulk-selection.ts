'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { TODO_BULK_LIMIT, type TodoBulkAction, type TodoBulkSelectionItem } from '@/app/lib/todos/bulk-policy';

type Selection = { key: string; items: Map<string, TodoBulkSelectionItem>; all: boolean; excluded: number };

export function useTodoBulkSelection(filterKey: string, onSuccess: (ids: string[]) => Promise<void>) {
  const t = useTranslations('todos.bulk');
  const [state, setState] = useState<Selection>(() => ({ key: filterKey, items: new Map(), all: false, excluded: 0 }));
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const currentKey = useRef(filterKey);
  const success = useRef(onSuccess);
  useLayoutEffect(() => { success.current = onSuccess; }, [onSuccess]);
  const items = state.key === filterKey ? state.items : new Map<string, TodoBulkSelectionItem>();

  useLayoutEffect(() => {
    currentKey.current = filterKey;
    request.current?.abort();
    return () => request.current?.abort();
  }, [filterKey]);

  if (state.key !== filterKey) {
    setState({ key: filterKey, items: new Map(), all: false, excluded: 0 });
    setSelecting(false);
    setError('');
  }

  const clear = () => {
    if (operation.current) return;
    request.current?.abort();
    setSelecting(false);
    setError('');
    setState({ key: filterKey, items: new Map(), all: false, excluded: 0 });
  };

  const toggle = (item: TodoBulkSelectionItem) => {
    if (operation.current || selecting || !item.canWrite) return;
    setState((previous) => {
      const next = new Map(previous.key === filterKey ? previous.items : []);
      if (next.has(item.id)) next.delete(item.id);
      else if (next.size < TODO_BULK_LIMIT) next.set(item.id, item);
      return { key: filterKey, items: next, all: false, excluded: previous.excluded };
    });
  };

  const selectAll = async () => {
    if (operation.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSelecting(true);
    setError('');
    try {
      const response = await fetch(`/api/todos?${filterKey}&selection=true`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (controller.signal.aborted || currentKey.current !== filterKey) return;
      if (!response.ok || !payload.success) throw new Error(payload.code === 'TODO_SELECTION_LIMIT' ? t('limit', { limit: TODO_BULK_LIMIT }) : t('selectionFailed'));
      const rows = payload.data as TodoBulkSelectionItem[];
      const writable = rows.filter((item) => item.canWrite);
      setState({ key: filterKey, items: new Map(writable.map((item) => [item.id, item])), all: writable.length > 0, excluded: rows.length - writable.length });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('selectionFailed'));
    } finally {
      if (request.current === controller) setSelecting(false);
    }
  };

  const run = async (action: TodoBulkAction) => {
    if (operation.current || selecting || !items.size) return false;
    operation.current = true;
    setBusy(true);
    setError('');
    const snapshot = [...items.values()].map((item) => ({ id: item.id, expectedUpdatedAt: item.updatedAt }));
    try {
      const response = await fetch('/api/todos/bulk', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: snapshot, action }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        const message = response.status === 409 ? t('conflict') : response.status === 429 ? t('rateLimited') : t('failed');
        if (currentKey.current === filterKey) setError(message);
        toast.error(message);
        return false;
      }
      if (currentKey.current === filterKey) setState({ key: filterKey, items: new Map(), all: false, excluded: 0 });
      toast.success(t('success', { count: payload.data.count }));
      try {
        await success.current(payload.data.ids);
      } catch {
        toast.error(t('refreshFailed'));
      }
      return true;
    } catch {
      const message = t('unknownOutcome');
      if (currentKey.current === filterKey) setError(message);
      toast.error(message);
      return false;
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  return { items, all: state.key === filterKey && state.all, excluded: state.key === filterKey ? state.excluded : 0, selecting, busy, error, clear, toggle, selectAll, run };
}
