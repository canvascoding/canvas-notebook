'use client';

import { useTranslations } from 'next-intl';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WorkspaceOperationReviewPublic } from '@/app/lib/files/workspace-operation-review-contract';
import type { OperationCheckState } from './workspaceOperationCheckController';

export function WorkspaceOperationCheckDetails({ state, reviews, onCheckAgain, selectionChanged = false, canCheckAgain = true, showPaths = true }: {
  state: OperationCheckState; reviews: WorkspaceOperationReviewPublic[]; onCheckAgain: () => void;
  selectionChanged?: boolean; canCheckAgain?: boolean; showPaths?: boolean;
}) {
  const t = useTranslations('workspaceOperationReview');
  const running = ['starting', 'queued', 'checking'].includes(state.status);
  return <section className="m-4 space-y-3 rounded-lg border bg-muted/20 p-3 text-sm sm:mx-6"
    data-testid="workspace-operation-check-status" data-status={selectionChanged ? 'stale' : state.status} data-check-id={state.check?.checkId ?? ''}
    role="status" aria-live="polite">
    <h2 className="flex items-center gap-2 font-semibold">{running ? <Loader2 className="size-4 animate-spin" /> : null}{t(selectionChanged ? 'checkSelectionChanged' : `checkStatus_${state.status}`)}</h2>
    <p className="text-xs text-muted-foreground">{t(selectionChanged ? 'checkSelectionChangedHelp' : running ? 'checkContinuesAfterClose' : state.status === 'stale' ? 'checkStaleHelp'
      : state.status === 'blocked' ? 'checkBlockedHelp' : state.status === 'failed' ? 'checkFailedHelp' : 'checkReadyHelp')}</p>
    {showPaths ? <div className="space-y-2" data-testid="workspace-operation-check-paths">
      {reviews.flatMap((review) => review.selections.map((selection) => <p key={`${review.reviewId}:${selection.sourcePath}`} className="break-all font-mono text-xs">
        <span className="font-sans font-semibold">{t(`kind_${review.kind}`)}: </span>{selection.sourcePath}{selection.destinationPath ? ` → ${selection.destinationPath}` : ''}
      </p>))}
    </div> : null}
    {state.error || state.check?.errorCode ? <p role="alert" className="break-words text-xs text-destructive">{state.error ?? state.check?.errorCode}</p> : null}
    {!running || selectionChanged ? <Button data-testid="workspace-operation-check-again" variant="outline" size="sm" onClick={onCheckAgain} disabled={!canCheckAgain}>
      <RefreshCw className="size-4" />{t('checkAgain')}
    </Button> : null}
  </section>;
}
