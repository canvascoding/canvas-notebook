'use client';

import { Check, LoaderCircle, MessageSquareText, RotateCcw, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  FILE_VERSION_CENTER_ERROR_CODES,
  type FileVersionCenterRequestV1,
  type FileVersionCurrentFenceV1,
  type FileVersionTimelineEntryV1,
} from '@/app/lib/file-version-center/contracts/v1';
import {
  FileVersionActionError,
  fileVersionActionController,
  type FileVersionActionController,
  type FileVersionMutation,
} from '@/app/lib/file-version-center/action-client';

type CandidateEntry = Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' | 'revision' }>;

function actionErrorKey(error: unknown): string {
  if (!(error instanceof FileVersionActionError)) return 'actions.errorGeneric';
  if (error.code === 'AGENT_PROPOSAL_CHANGED') return 'actions.errorProposalChanged';
  if (error.code === FILE_VERSION_CENTER_ERROR_CODES.accessDenied) return 'actions.errorAccessLost';
  if ([
    FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
    FILE_VERSION_CENTER_ERROR_CODES.conflict,
  ].includes(error.code as never)) return 'actions.errorCurrentChanged';
  return 'actions.errorGeneric';
}

export function FileVersionActions({
  request,
  current,
  entry,
  reviewedProposalVersion,
  candidateAvailable,
  restoreAllowed,
  onTimelineInvalidate,
  onContinue,
  controller = fileVersionActionController,
}: {
  request: FileVersionCenterRequestV1;
  current: Extract<FileVersionTimelineEntryV1, { kind: 'current' }>;
  entry: CandidateEntry;
  reviewedProposalVersion: string | null;
  candidateAvailable: boolean;
  restoreAllowed: boolean;
  onTimelineInvalidate: (action?: FileVersionMutation) => Promise<void> | void;
  onContinue: () => void;
  controller?: FileVersionActionController;
}) {
  const t = useTranslations('fileVersionCenter');
  const [busy, setBusy] = useState<FileVersionMutation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const fence: FileVersionCurrentFenceV1 = {
    revisionId: current.revisionId,
    sha256: current.sha256,
    ...(current.stateVectorHash ? { stateVectorHash: current.stateVectorHash } : {}),
  };

  const perform = useCallback(async (
    action: FileVersionMutation,
    operation: () => Promise<unknown>,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setError(null);
    try {
      await operation();
      await onTimelineInvalidate(action);
    } catch (actionError) {
      setError(actionError);
      if (actionError instanceof FileVersionActionError && [
        'AGENT_PROPOSAL_CHANGED',
        FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
        FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
        FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
        FILE_VERSION_CENTER_ERROR_CODES.conflict,
      ].includes(actionError.code as never)) {
        await onTimelineInvalidate();
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [onTimelineInvalidate]);

  const execute = useCallback((
    action: FileVersionMutation,
    operation: () => Promise<unknown>,
  ) => {
    retryRef.current = () => perform(action, operation);
    return perform(action, operation);
  }, [perform]);

  const acceptEnabled = entry.kind === 'agent_operation'
    && entry.actionsAllowed
    && candidateAvailable
    && typeof reviewedProposalVersion === 'string';
  const rejectEnabled = entry.kind === 'agent_operation' && entry.actionsAllowed;
  const restoreEnabled = entry.kind === 'revision'
    && entry.restorable
    && restoreAllowed
    && candidateAvailable;
  const busyLabel = busy ? t(`actions.busy.${busy}`) : null;

  return (
    <div className="shrink-0 border-t bg-muted/15 px-4 py-3 sm:px-5">
      {error ? (
        <Alert variant="destructive" className="mb-3 rounded-lg" data-testid="file-version-action-error">
          <AlertTitle>{t(actionErrorKey(error))}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('actions.errorDescription')}</span>
            {error instanceof FileVersionActionError && error.retryable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => { void retryRef.current?.(); }}
              >
                {t('actions.retry')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={onContinue}>
          <MessageSquareText className="size-4" aria-hidden="true" />
          {t('actions.continue')}
        </Button>
        <div className="flex flex-col-reverse gap-2 min-[440px]:flex-row min-[440px]:justify-end">
          {rejectEnabled && entry.kind === 'agent_operation' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => { void execute('reject', () => controller.reject({
                operationId: entry.operationId,
                workspaceId: request.target.workspaceId,
                reviewedProposalVersion,
              })); }}
            >
              {busy === 'reject'
                ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <X className="size-4" aria-hidden="true" />}
              {t('actions.reject')}
            </Button>
          ) : null}
          {acceptEnabled && entry.kind === 'agent_operation' ? (
            <Button
              type="button"
              size="sm"
              className="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
              disabled={Boolean(busy)}
              onClick={() => { void execute('accept', () => controller.accept({
                operationId: entry.operationId,
                workspaceId: request.target.workspaceId,
                reviewedProposalVersion: reviewedProposalVersion!,
              })); }}
            >
              {busy === 'accept'
                ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <Check className="size-4" aria-hidden="true" />}
              {t('actions.accept')}
            </Button>
          ) : null}
          {restoreEnabled && entry.kind === 'revision' ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" size="sm" disabled={Boolean(busy)}>
                  <RotateCcw className="size-4" aria-hidden="true" />
                  {t('actions.restore')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('actions.restoreTitle', { number: entry.revisionNumber })}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('actions.restoreDescription', {
                      revision: current.revisionId ?? t('details.notCaptured'),
                      hash: current.sha256.slice(0, 12),
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => { void execute('restore', () => controller.restore({
                      target: request.target,
                      revisionId: entry.revisionId,
                      expectedCurrent: fence,
                    })); }}
                  >
                    {t('actions.confirmRestore')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>
      {busyLabel ? <p role="status" className="mt-2 text-right text-xs text-muted-foreground">{busyLabel}</p> : null}
    </div>
  );
}
