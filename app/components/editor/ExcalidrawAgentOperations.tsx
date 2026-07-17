'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, Check, LoaderCircle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { workspaceHeaders } from '@/app/lib/files/client';

type ReviewOperation = {
  operationId: string;
  actorId: string;
  status: string;
  reviewReason: string | null;
  actions: Array<{ type: 'create' | 'update' | 'delete'; elementId?: string; element?: { id?: string } }>;
  updatedAt: number;
};

export function ExcalidrawAgentOperations({
  documentId,
  readOnly,
}: {
  documentId: string | null;
  readOnly: boolean;
}) {
  const t = useTranslations('notebook.collaboration');
  const [operations, setOperations] = useState<ReviewOperation[]>([]);
  const [busyOperationId, setBusyOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!documentId) return setOperations([]);
    try {
      const response = await fetch(
        `/api/files/excalidraw-collaboration/operations?documentId=${encodeURIComponent(documentId)}&pending=1`,
        { headers: workspaceHeaders(), cache: 'no-store' },
      );
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        operations?: ReviewOperation[];
        error?: string;
      };
      if (!response.ok || !payload.success) throw new Error(payload.error || t('agentActionFailed'));
      setOperations(payload.operations ?? []);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('agentActionFailed'));
    }
  }, [documentId, t]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const act = useCallback(async (operationId: string, action: 'accept' | 'reject') => {
    setBusyOperationId(operationId);
    setError(null);
    try {
      const response = await fetch(
        `/api/files/excalidraw-collaboration/operations/${encodeURIComponent(operationId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
          body: JSON.stringify({ idempotencyKey: `${action}:${operationId}:${crypto.randomUUID()}` }),
        },
      );
      const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || t('agentActionFailed'));
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('agentActionFailed'));
    } finally {
      setBusyOperationId(null);
    }
  }, [refresh, t]);

  if (!documentId || (operations.length === 0 && !error)) return null;

  return (
    <aside
      className="pointer-events-auto absolute bottom-14 right-3 z-[90] w-[min(360px,calc(100%-1.5rem))] overflow-hidden rounded-2xl border border-amber-500/25 bg-background/95 shadow-2xl backdrop-blur-xl"
      aria-label={t('agentOperations')}
      data-testid="excalidraw-agent-review"
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-amber-500/8 px-3.5 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{t('agentOperations')}</p>
          <p className="text-xs text-muted-foreground">{t('agentStatus_needs_review')}</p>
        </div>
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:text-amber-200">
          {operations.length}
        </span>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto p-2.5">
        {operations.map((operation) => {
          const pending = busyOperationId === operation.operationId;
          const targets = operation.actions
            .map((action) => action.elementId || action.element?.id)
            .filter(Boolean)
            .slice(0, 3)
            .join(', ');
          return (
            <div key={operation.operationId} className="rounded-xl border border-border/70 bg-card/80 p-3 shadow-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">{t('agentAttribution', { agent: operation.actorId })}</p>
                  {operation.reviewReason ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{operation.reviewReason}</p>
                  ) : null}
                  {targets ? <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{targets}</p> : null}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={readOnly || pending}
                  onClick={() => void act(operation.operationId, 'reject')}
                >
                  {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  {t('agentReject')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={readOnly || pending}
                  onClick={() => void act(operation.operationId, 'accept')}
                >
                  {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {t('agentAccept')}
                </Button>
              </div>
            </div>
          );
        })}
        {error ? (
          <div className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
