'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { authClient } from '@/app/lib/auth-client';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { closeWorkspacePathOperationStatus, openWorkspacePathOperationStatus, recoverWorkspacePathOperation,
  reloadWorkspacePathOperationStatus, useWorkspacePathOperationStore } from '@/app/store/workspace-path-operation-store';

function subscribeAuth(listener: () => void) {
  const session = authClient.$store.atoms.session.listen(listener);
  const invalidation = subscribeOpenedDocumentAuthInvalidation(listener);
  return () => { session(); invalidation(); };
}

/** Always available, including when the optional Review Center is disabled. */
export function WorkspacePathOperationStatusHost() {
  const t = useTranslations('workspacePathOperationStatus');
  const params = useSearchParams();
  const authScope = useSyncExternalStore(subscribeAuth, openedDocumentAuthScope, () => null);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const state = useWorkspacePathOperationStore();
  const lastNavigation = useRef<string | null>(null);
  const request = state.request && state.request.authScope === authScope
    && state.request.workspaceId === activeWorkspaceId ? state.request : null;

  useEffect(() => {
    if (state.request && !request) closeWorkspacePathOperationStatus();
  }, [state.request, request]);

  useEffect(() => {
    if (!authScope) return;
    const workspaceId = params.get('workspaceId');
    const batchId = params.get('workspacePathBatch');
    const problemId = params.get('workspacePathProblem');
    if (!workspaceId || Boolean(batchId) === Boolean(problemId)) return;
    const navigation = JSON.stringify([workspaceId, batchId, problemId]);
    if (lastNavigation.current === navigation) return;
    lastNavigation.current = navigation;
    // Consume before hydration so a delayed route snapshot cannot reopen a dismissed dialog.
    const url = new URL(window.location.href);
    url.searchParams.delete('workspacePathBatch');
    url.searchParams.delete('workspacePathProblem');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    void openWorkspacePathOperationStatus(batchId ? { workspaceId, batchId } : { workspaceId, problemId: problemId! })
      .then((opened) => { if (!opened && openedDocumentAuthScope() === authScope) toast.error(t('openFailed')); });
  }, [authScope, params, t]);

  useEffect(() => {
    const reset = () => { lastNavigation.current = null; };
    window.addEventListener('popstate', reset);
    return () => window.removeEventListener('popstate', reset);
  }, []);

  useEffect(() => {
    if (!request) return;
    const load = window.setTimeout(() => { void reloadWorkspacePathOperationStatus(); }, 0);
    const poll = window.setInterval(() => {
      const current = useWorkspacePathOperationStore.getState();
      if (current.request === request && !current.loading
        && ['queued', 'applying'].includes(current.response?.operation.status ?? '')) void reloadWorkspacePathOperationStatus();
    }, 2000);
    return () => { window.clearTimeout(load); window.clearInterval(poll); };
  }, [request]);

  const operation = request ? state.response?.operation : null;
  const problem = request ? state.problem : null;
  const running = Boolean(operation && ['queued', 'applying'].includes(operation.status));
  const settled = Boolean(operation && ['applied', 'undone'].includes(operation.status));
  const selections = operation?.selections ?? problem?.selections ?? [];
  const code = state.errorCode ?? operation?.errorCode ?? problem?.errorCode;
  const status = operation?.status === 'needs_review' ? 'stale' : operation?.status === 'preview' ? 'blocked' : operation?.status;
  const guidance = problem ? problem.errorCode === 'BATCH_AUDIT_FAILED' ? 'auditFailed' : 'problemGuidance'
    : status ? `guidance.${status}` : null;
  const canRecover = Boolean(request && !state.loading && !state.busy && !state.error && !running);

  return <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) closeWorkspacePathOperationStatus(); }}>
    <DialogContent layout="viewport" showCloseButton={false} data-testid="workspace-path-operation-status"
      className="sm:mx-auto sm:max-w-2xl" onCloseAutoFocus={(event) => event.preventDefault()}>
      <div className="flex shrink-0 items-start gap-3 border-b p-4 sm:p-6">
        <div className="min-w-0 flex-1">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="mt-2">{t('description')}</DialogDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={closeWorkspacePathOperationStatus} aria-label={t('close')}><X className="h-4 w-4" /></Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
        <div aria-live="polite" aria-atomic="true" className="space-y-3">
          {state.loading && !operation && !problem ? <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</p> : null}
          {operation || problem ? <div className="flex items-start gap-3 rounded-lg border p-4">
            {running || state.busy ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
              : settled ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" /> : <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
            <div className="min-w-0 space-y-2">
              <p className="font-medium">{problem ? t('problemTitle') : t(`status.${status}`)}</p>
              {guidance ? <p className="text-sm text-muted-foreground">{t(guidance)}</p> : null}
              {operation ? <p className="text-sm text-muted-foreground">{t('progress', { completed: operation.completedActions, total: operation.totalActions })}</p> : null}
              {state.pendingAction ? <p className="text-sm">{t(state.pendingAction === 'undo' ? 'undoing' : 'resuming')}</p> : null}
            </div>
          </div> : null}
          {state.error ? <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{t(`error.${state.error}`)}</p> : null}
          {code ? <p className="break-all text-sm"><span className="text-muted-foreground">{t('errorCode')}: </span><code>{code}</code></p> : null}
        </div>
        {selections.length ? <section aria-label={t('files')} className="space-y-3">
          <h2 className="text-sm font-medium">{t('files')}</h2>
          <ul className="divide-y rounded-lg border">
            {selections.slice(0, 20).map((selection, index) => <li key={index} className="space-y-1 p-3 text-sm [overflow-wrap:anywhere]">
              <span className="block">{selection.sourcePath}</span>
              {selection.destinationPath ? <span className="flex items-start gap-2 text-muted-foreground"><ArrowRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span>{selection.destinationPath}</span></span> : null}
            </li>)}
          </ul>
          {selections.length > 20 ? <p className="text-sm text-muted-foreground">{t('moreFiles', { count: selections.length - 20 })}</p> : null}
        </section> : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t p-4 sm:px-6">
        <Button variant="outline" disabled={state.loading || state.busy} onClick={() => void reloadWorkspacePathOperationStatus()}><RefreshCw className="h-4 w-4" />{t('refresh')}</Button>
        {state.response?.recovery?.canUndo && request ? <Button variant="outline" data-testid="workspace-path-operation-undo" disabled={!canRecover}
          onClick={() => void recoverWorkspacePathOperation('undo')}>{t('undo')}</Button> : null}
        {state.response?.recovery?.canResume && request ? <Button data-testid="workspace-path-operation-resume" disabled={!canRecover}
          onClick={() => void recoverWorkspacePathOperation('resume')}>{t('resume')}</Button> : null}
        <Button variant="outline" onClick={closeWorkspacePathOperationStatus}>{t('close')}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
