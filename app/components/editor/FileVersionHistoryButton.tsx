'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileClock, Loader2, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDocumentReviewAvailability } from '@/app/components/file-version-center/DocumentReviewAvailabilityProvider';

import type { CollaborationAgentOperation } from '@/app/lib/collaboration/agent-operations-client';
import { resolveFileVersionCenterWhenReady } from '@/app/lib/file-version-center/client';
import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  type FileVersionCapabilitiesV1,
  type FileVersionCenterTargetV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { classifyFileVersionFileV1 } from '@/app/lib/file-version-center/policy-v1';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  buildEditorAgentVersionCenterRequest,
  summarizeEditorAgentOperations,
} from './CollaborationAgentOperations';

type CapabilityState =
  | { key: string; state: 'loading' }
  | { key: string; state: 'error' }
  | {
      key: string;
      state: 'ready';
      capabilities: FileVersionCapabilitiesV1;
      target: Extract<FileVersionCenterTargetV1, { kind: 'lineage' }>;
    };

export function isEditorFileVersionSupported(path: string): boolean {
  const fileClass = classifyFileVersionFileV1(path);
  return fileClass === 'markdown' || fileClass === 'text';
}

export function editorFileVersionTarget(input: {
  workspaceId: string;
  path: string;
  documentId?: string | null;
}): FileVersionCenterTargetV1 {
  return input.documentId
    ? { kind: 'document', workspaceId: input.workspaceId, documentId: input.documentId }
    : { kind: 'path', workspaceId: input.workspaceId, pathHint: input.path };
}

export function FileVersionHistoryButton({
  workspaceId,
  path,
  documentId,
  agentOperations = [],
}: {
  workspaceId: string | null;
  path: string;
  documentId?: string | null;
  agentOperations?: CollaborationAgentOperation[];
}) {
  const t = useTranslations('notebook');
  const { documentReviewEnabled, updatedAt } = useDocumentReviewAvailability();
  const collaborationT = useTranslations('notebook.collaboration');
  const supported = isEditorFileVersionSupported(path);
  const agentSummary = useMemo(() => summarizeEditorAgentOperations(agentOperations), [agentOperations]);
  const hasPendingReviews = Boolean(workspaceId && documentId && agentSummary.reviewCount > 0);
  const target = useMemo(() => workspaceId ? editorFileVersionTarget({ workspaceId, path, documentId }) : null,
    [documentId, path, workspaceId]);
  const targetKey = target ? JSON.stringify([target, documentReviewEnabled, updatedAt]) : '';
  const [resolvedCapability, setResolvedCapability] = useState<CapabilityState>({ key: '', state: 'loading' });
  const capability: CapabilityState = resolvedCapability.key === targetKey
    ? resolvedCapability
    : { key: targetKey, state: 'loading' };

  useEffect(() => {
    if (!documentReviewEnabled || !target || !supported) return;
    const controller = new AbortController();
    void resolveFileVersionCenterWhenReady({
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      target,
      initialView: 'history',
      source: 'editor',
    }, controller.signal).then((timeline) => {
      if (controller.signal.aborted || timeline.document.workspaceId !== target.workspaceId) return;
      setResolvedCapability({
        key: targetKey,
        state: 'ready',
        capabilities: timeline.capabilities,
        target: {
          kind: 'lineage',
          workspaceId: timeline.document.workspaceId,
          lineageId: timeline.document.lineageId,
        },
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setResolvedCapability({ key: targetKey, state: 'error' });
    });
    return () => controller.abort();
  }, [documentReviewEnabled, supported, target, targetKey]);

  if (!documentReviewEnabled || !target || (!supported && !hasPendingReviews)) return null;
  const loading = supported && capability.state === 'loading';
  const historyEnabled = capability.state === 'ready' && capability.capabilities.history;
  const enabled = hasPendingReviews || historyEnabled;
  const readOnly = capability.state === 'ready' && capability.capabilities.history
    && !capability.capabilities.restore;
  const label = hasPendingReviews
    ? agentSummary.conflictCount > 0
      ? collaborationT('agentOperationsConflictLabel', { count: agentSummary.conflictCount })
      : collaborationT('agentOperationsReviewLabel', { count: agentSummary.reviewCount })
    : loading ? t('fileVersionHistoryLoading')
      : capability.state === 'error' || !historyEnabled ? t('fileVersionHistoryUnavailable')
      : readOnly ? t('fileVersionHistoryReadOnly')
        : t('fileVersionHistory');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'relative h-6 w-6 shrink-0 p-0 text-xs 2xl:w-auto 2xl:gap-1.5 2xl:px-2',
            hasPendingReviews && agentSummary.conflictCount === 0
              && 'border border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 hover:text-violet-800 dark:border-violet-700 dark:bg-violet-950/50 dark:text-violet-300 dark:hover:bg-violet-900/60',
            hasPendingReviews && agentSummary.conflictCount > 0
              && 'border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-900/60',
          )}
          disabled={!enabled}
          aria-busy={loading && !hasPendingReviews}
          aria-label={label}
          data-agent-review-state={hasPendingReviews
            ? agentSummary.conflictCount > 0 ? 'conflict' : 'review'
            : 'none'}
          data-file-version-capability={capability.state === 'ready'
            ? capability.capabilities.history ? readOnly ? 'read-only' : 'full' : 'unavailable'
            : capability.state}
          onClick={() => {
            if (hasPendingReviews && workspaceId && documentId) {
              openVersionCenter(buildEditorAgentVersionCenterRequest({
                documentId,
                workspaceId,
                summary: agentSummary,
              }));
              return;
            }
            if (capability.state !== 'ready' || !capability.capabilities.history) return;
            openVersionCenter({
              contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
              target: capability.target,
              initialView: 'history',
              source: 'editor',
            });
          }}
        >
          {hasPendingReviews && agentSummary.conflictCount > 0
            ? <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            : loading
            ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <FileClock className="h-3.5 w-3.5" aria-hidden="true" />}
          <span className="hidden 2xl:inline">{t('fileVersionHistoryShort')}</span>
          {hasPendingReviews ? (
            <span
              className={cn(
                'absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white',
                agentSummary.conflictCount > 0 ? 'bg-amber-600' : 'bg-violet-600',
              )}
              aria-hidden="true"
            >
              {agentSummary.reviewCount}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
