'use client';

import {
  AlertTriangle,
  Braces,
  Code2,
  Columns2,
  FileDiff,
  FileQuestion,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { useTranslations } from 'next-intl';

import { InertMarkdownPreview } from '@/app/components/shared/InertMarkdownPreview';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  FileVersionCenterRequestV1,
  FileVersionCurrentFenceV1,
  FileVersionDiffHunkV1,
  FileVersionTimelineEntryV1,
  FileVersionTimelineResponseV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from '@/app/lib/file-version-center/contracts/v1';
import {
  compareFileVersion,
  mergeFileVersionComparePayload,
  type FileVersionComparePayload,
} from '@/app/lib/file-version-center/compare-client';
import { FileVersionCenterClientError } from '@/app/lib/file-version-center/client';
import type { FileVersionMutation } from '@/app/lib/file-version-center/action-client';
import type { FileVersionTimelineSelection } from '@/app/lib/file-version-center/timeline-state';
import { cn } from '@/lib/utils';

import { FileVersionLoadingSkeleton } from './FileVersionLoadingSkeleton';
import { FileVersionActions } from './FileVersionActions';

type CandidateEntry = Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' | 'revision' }>;
type TimelineRefreshState = 'idle' | 'refreshing' | 'confirmed_stale' | 'failed';

function selectionFor(entry: CandidateEntry) {
  return { kind: entry.kind, id: entry.id } as const;
}

function currentFence(entry: Extract<FileVersionTimelineEntryV1, { kind: 'current' }>): FileVersionCurrentFenceV1 {
  return {
    revisionId: entry.revisionId,
    sha256: entry.sha256,
    ...(entry.stateVectorHash ? { stateVectorHash: entry.stateVectorHash } : {}),
  };
}

function SynchronizedPanes({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  left: ReactNode;
  right: ReactNode;
  leftLabel: string;
  rightLabel: string;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const synchronizingRef = useRef<'left' | 'right' | null>(null);

  const synchronize = useCallback((side: 'left' | 'right', event: UIEvent<HTMLDivElement>) => {
    if (synchronizingRef.current && synchronizingRef.current !== side) return;
    const source = event.currentTarget;
    const target = side === 'left' ? rightRef.current : leftRef.current;
    if (!target) return;
    synchronizingRef.current = side;
    const sourceRange = Math.max(1, source.scrollHeight - source.clientHeight);
    const targetRange = Math.max(0, target.scrollHeight - target.clientHeight);
    target.scrollTop = (source.scrollTop / sourceRange) * targetRange;
    queueMicrotask(() => { synchronizingRef.current = null; });
  }, []);

  return (
    <div data-synchronized-scroll="true" className="grid min-h-0 grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">
      <div
        ref={leftRef}
        tabIndex={0}
        role="region"
        aria-label={leftLabel}
        onScroll={(event) => synchronize('left', event)}
        className="max-h-[48dvh] min-w-0 overflow-auto bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {left}
      </div>
      <div
        ref={rightRef}
        tabIndex={0}
        role="region"
        aria-label={rightLabel}
        onScroll={(event) => synchronize('right', event)}
        className="max-h-[48dvh] min-w-0 overflow-auto bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {right}
      </div>
    </div>
  );
}

function DiffSide({
  hunks,
  side,
  heading,
}: {
  hunks: FileVersionDiffHunkV1[];
  side: 'current' | 'candidate';
  heading: string;
}) {
  return (
    <div className="min-w-max">
      <div className={cn(
        'sticky top-0 z-10 border-b bg-background/95 px-3 py-2 text-xs font-semibold backdrop-blur-sm',
        side === 'candidate' && 'text-violet-700 dark:text-violet-300',
      )}>{heading}</div>
      {hunks.map((hunk) => (
        <section key={hunk.id} aria-label={`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`}>
          <div className="border-y bg-muted/45 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}
          </div>
          <pre className="m-0 text-xs leading-5">
            {hunk.lines.map((line, index) => {
              const visible = side === 'current' ? line.kind !== 'addition' : line.kind !== 'deletion';
              const number = side === 'current' ? line.oldLineNumber : line.newLineNumber;
              const changed = side === 'current' ? line.kind === 'deletion' : line.kind === 'addition';
              return (
                <span
                  key={`${hunk.id}:${side}:${index}`}
                  className={cn(
                    'grid grid-cols-[3.25rem_1.25rem_minmax(max-content,1fr)] border-b border-border/30',
                    changed && side === 'current' && 'bg-destructive/[0.07] text-destructive',
                    changed && side === 'candidate' && 'bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-200',
                    !visible && 'text-transparent select-none',
                  )}
                >
                  <span aria-hidden="true" className="border-r bg-muted/20 px-2 text-right tabular-nums text-muted-foreground">
                    {visible ? number : ''}
                  </span>
                  <span aria-hidden="true" className="text-center">{visible ? line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' ' : ' '}</span>
                  <span className="whitespace-pre px-2">{visible ? line.text || ' ' : ' '}</span>
                </span>
              );
            })}
          </pre>
        </section>
      ))}
    </div>
  );
}

function SourceSide({ heading, content, candidate = false }: { heading: string; content: string; candidate?: boolean }) {
  return (
    <div className="min-w-max">
      <div className={cn(
        'sticky top-0 z-10 border-b bg-background/95 px-3 py-2 text-xs font-semibold backdrop-blur-sm',
        candidate && 'text-violet-700 dark:text-violet-300',
      )}>{heading}</div>
      <pre className="m-0 whitespace-pre p-4 font-mono text-xs leading-5">{content || ' '}</pre>
    </div>
  );
}

function ComparisonDetails({ payload, entry }: { payload: FileVersionComparePayload; entry: CandidateEntry }) {
  const t = useTranslations('fileVersionCenter');
  const details = [
    [t('details.candidateType'), entry.kind === 'agent_operation' ? t('agentProposal') : t('revisionNumber', { number: entry.revisionNumber })],
    [t('details.candidateId'), entry.id],
    [t('details.currentRevision'), payload.response.current.fence.revisionId ?? t('details.notCaptured')],
    [t('details.currentHash'), payload.response.current.fence.sha256],
    [t('details.previewFormat'), payload.preview.format],
    [t('details.blockedReferences'), String(payload.preview.blockedExternalReferences)],
    [t('details.changedBlocks'), String(payload.preview.blocks.changed)],
  ];
  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
      {details.map(([label, value]) => (
        <div key={label} className="min-w-0 bg-background p-3">
          <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LoadedComparison({
  request,
  current,
  entry,
  restoreAllowed,
  lineageId,
  timelineRefreshing,
  timelineStale,
  onTimelineInvalidate,
  onContinue,
}: {
  request: FileVersionCenterRequestV1;
  current: Extract<FileVersionTimelineEntryV1, { kind: 'current' }>;
  entry: CandidateEntry;
  restoreAllowed: boolean;
  lineageId: string;
  timelineRefreshing: boolean;
  timelineStale: boolean;
  onTimelineInvalidate: (action?: FileVersionMutation) => Promise<void> | void;
  onContinue: () => void;
}) {
  const t = useTranslations('fileVersionCenter');
  const [snapshot, setSnapshot] = useState<{ identity: string; payload: FileVersionComparePayload } | null>(null);
  const payload = snapshot?.payload ?? null;
  const [error, setError] = useState<FileVersionCenterClientError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryVersion, setRetryVersion] = useState(0);
  const [loadingHunks, setLoadingHunks] = useState(false);
  const [hunkError, setHunkError] = useState<string | null>(null);
  const [timelineRefreshState, setTimelineRefreshState] = useState<TimelineRefreshState>('idle');
  const timelineRefreshInFlightRef = useRef(false);
  const fence = useMemo(() => currentFence(current), [current]);
  const candidate = useMemo(() => selectionFor(entry), [entry]);
  const proposalVersion = entry.kind === 'agent_operation' ? entry.proposalVersion ?? null : null;
  const identity = JSON.stringify([request.target, lineageId, candidate, fence, proposalVersion]);
  const generationRef = useRef(0);
  const paginationRef = useRef<AbortController | null>(null);
  const reviewPending = timelineRefreshing || timelineStale || loading || snapshot?.identity !== identity || Boolean(error);

  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
      paginationRef.current?.abort();
      paginationRef.current = null;
    };
  }, [identity, retryVersion]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = generationRef.current;
    const isCurrent = () => !controller.signal.aborted && generation === generationRef.current;
    Promise.resolve().then(() => {
      if (!isCurrent()) return;
      setLoading(true);
      setError(null);
      setLoadingHunks(false);
      setHunkError(null);
    });
    void compareFileVersion({
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      target: request.target,
      candidate,
      expectedCurrent: fence,
      limit: 20,
    }, controller.signal, { lineageId, proposalVersion, force: retryVersion > 0 }).then((result) => {
      if (!isCurrent()) return;
      setSnapshot({ identity, payload: result });
      setLoading(false);
      if (timelineRefreshInFlightRef.current) {
        const remainsUnavailable = result.response.candidate.stale
          || !result.response.candidate.contentAvailable
          || result.preview.candidate === null;
        timelineRefreshInFlightRef.current = false;
        setTimelineRefreshState(remainsUnavailable ? 'confirmed_stale' : 'idle');
      } else setTimelineRefreshState('idle');
    }).catch((loadError: unknown) => {
      if (!isCurrent() || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
      if (timelineRefreshInFlightRef.current) {
        timelineRefreshInFlightRef.current = false;
        setTimelineRefreshState('failed');
      }
      setError(loadError instanceof Error ? loadError : new Error(t('compareFailed')));
      setLoading(false);
    });
    return () => controller.abort();
  }, [candidate, fence, identity, lineageId, proposalVersion, request.target, retryVersion, t]);

  const retry = () => {
    setError(null);
    setLoading(true);
    setRetryVersion((value) => value + 1);
  };

  const refreshTimeline = useCallback(async () => {
    if (timelineRefreshInFlightRef.current) return;
    timelineRefreshInFlightRef.current = true;
    setTimelineRefreshState('refreshing');
    try {
      await onTimelineInvalidate();
      setRetryVersion((value) => value + 1);
    } catch {
      timelineRefreshInFlightRef.current = false;
      setTimelineRefreshState('failed');
    }
  }, [onTimelineInvalidate]);

  const loadMoreHunks = async () => {
    const cursor = payload?.response.page.nextCursor;
    if (!payload?.response.page.hasMore || !cursor || loadingHunks || reviewPending || paginationRef.current) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    paginationRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && generation === generationRef.current;
    setLoadingHunks(true);
    setHunkError(null);
    try {
      const page = await compareFileVersion({
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        target: request.target, candidate, expectedCurrent: fence, cursor, limit: 20,
      }, controller.signal, { lineageId, proposalVersion });
      if (!isCurrent()) return;
      // Validate before entering React's state updater so failures remain retryable.
      const merged = mergeFileVersionComparePayload(payload, page);
      setSnapshot((currentSnapshot) => currentSnapshot?.identity === identity
        ? { identity, payload: merged } : currentSnapshot);
    } catch (pageError) {
      if (isCurrent()) setHunkError(pageError instanceof Error ? pageError.message : t('hunksFailed'));
    } finally {
      if (paginationRef.current === controller) paginationRef.current = null;
      if (isCurrent()) setLoadingHunks(false);
    }
  };

  if (loading && !payload) return <FileVersionLoadingSkeleton label={t('loadingComparison')} />;
  if (!payload) {
    const changed = error instanceof FileVersionCenterClientError
      && ['FVRC_STALE_CURRENT', 'FVRC_STALE_SELECTION', 'FVRC_CONFLICT'].includes(error.code);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center p-5">
          <Alert variant={changed ? 'default' : 'destructive'} className="max-w-xl rounded-lg">
            {changed ? <AlertTriangle aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
            <AlertTitle>{changed ? t('comparisonChanged') : t('compareFailed')}</AlertTitle>
            <AlertDescription>
              <p>{error?.message ?? t('compareFailed')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={changed && timelineRefreshState === 'refreshing'}
                onClick={() => { if (changed) void refreshTimeline(); else retry(); }}
              >
                {changed && timelineRefreshState === 'refreshing'
                  ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <RefreshCw className="size-4" aria-hidden="true" />}
                {changed
                  ? timelineRefreshState === 'refreshing' ? t('refreshingTimeline') : t('refreshTimeline')
                  : t('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
        {entry.kind === 'agent_operation' ? (
          <FileVersionActions
            request={request}
            current={current}
            entry={entry}
            reviewedProposalVersion={null}
            candidateAvailable={false}
            restoreAllowed={restoreAllowed}
            onTimelineInvalidate={onTimelineInvalidate}
            onContinue={onContinue}
          />
        ) : null}
      </div>
    );
  }

  const selectedTitle = entry.kind === 'agent_operation'
    ? t('agentProposal')
    : t('revisionNumber', { number: entry.revisionNumber });
  const unavailable = payload.response.candidate.stale || !payload.response.candidate.contentAvailable
    || payload.preview.candidate === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {reviewPending ? (
        <div role={error ? 'alert' : 'status'} data-testid="file-version-comparison-refresh" className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3 text-sm">
          <span>{error?.message ?? (loading || timelineRefreshing ? t('loadingComparison') : t('comparisonChanged'))}</span>
          {!loading && !timelineRefreshing ? <Button variant="outline" size="sm" onClick={() => { void refreshTimeline(); }} disabled={timelineRefreshState === 'refreshing'}>
            <RefreshCw className="size-4" aria-hidden="true" />{t('refreshTimeline')}
          </Button> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{selectedTitle}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('comparedWithCurrent')}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-200">
            +{payload.response.summary.additions}
          </Badge>
          <Badge variant="outline" className="border-destructive/30 text-destructive">
            −{payload.response.summary.deletions}
          </Badge>
        </div>
      </div>
      {unavailable ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Alert className="m-4 rounded-lg border-amber-500/35 bg-amber-500/[0.06]">
            <AlertTriangle className="text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <AlertTitle>{t('candidateUnavailable')}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{timelineRefreshState === 'confirmed_stale'
                ? t('candidateUnavailableAfterRefresh')
                : timelineRefreshState === 'failed'
                  ? t('candidateUnavailableRefreshFailed')
                  : t('candidateUnavailableDescription')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={timelineRefreshState === 'refreshing'}
                onClick={() => { void refreshTimeline(); }}
              >
                {timelineRefreshState === 'refreshing'
                  ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <RefreshCw className="size-4" aria-hidden="true" />}
                {timelineRefreshState === 'refreshing'
                  ? t('refreshingTimeline')
                  : timelineRefreshState === 'failed'
                    ? t('retryTimeline')
                    : t('refreshTimeline')}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <Tabs defaultValue="changes" className="min-h-0 flex-1 gap-0 overflow-hidden">
          <div className="border-b px-3 py-2 sm:px-4">
            <TabsList aria-label={t('comparisonViews')} className="h-9 w-full justify-start overflow-x-auto">
              <TabsTrigger value="changes"><FileDiff aria-hidden="true" />{t('tabs.changes')}</TabsTrigger>
              <TabsTrigger value="preview"><Columns2 aria-hidden="true" />{t('tabs.preview')}</TabsTrigger>
              <TabsTrigger value="source"><Code2 aria-hidden="true" />{t('tabs.source')}</TabsTrigger>
              <TabsTrigger value="details"><Info aria-hidden="true" />{t('tabs.details')}</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="changes" className="min-h-0 overflow-auto p-3 sm:p-4">
            {payload.response.hunks.length > 0 ? (
              <SynchronizedPanes
                left={<DiffSide hunks={payload.response.hunks} side="current" heading={t('currentVersion')} />}
                right={<DiffSide hunks={payload.response.hunks} side="candidate" heading={selectedTitle} />}
                leftLabel={t('currentDiffLabel')}
                rightLabel={t('candidateDiffLabel')}
              />
            ) : (
              <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">{t('noDifferences')}</p>
            )}
            {payload.response.truncated ? (
              <p role="status" className="mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3.5" aria-hidden="true" />{t('comparisonTruncated')}
              </p>
            ) : null}
            {payload.response.page.hasMore || hunkError ? (
              <div className="mt-3 space-y-2">
                {hunkError ? <p role="alert" className="text-xs text-destructive">{hunkError}</p> : null}
                <Button type="button" variant="outline" onClick={() => { void loadMoreHunks(); }} disabled={loadingHunks || reviewPending}>
                  {loadingHunks
                    ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    : <Braces className="size-4" aria-hidden="true" />}
                  {loadingHunks ? t('loadingHunks') : hunkError ? t('retryHunks') : t('loadMoreHunks')}
                </Button>
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="preview" className="min-h-0 overflow-auto p-4 sm:p-6">
            <div className="mx-auto max-w-3xl">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{t('resultingCandidate')}</h3>
                {payload.preview.blockedExternalReferences > 0 ? (
                  <Badge variant="outline">{t('blockedReferences', { count: payload.preview.blockedExternalReferences })}</Badge>
                ) : null}
              </div>
              {payload.preview.format === 'markdown' ? (
                <InertMarkdownPreview
                  content={payload.preview.candidate ?? ''}
                  imageLabel={t('blockedImage')}
                  linkLabel={t('blockedLink')}
                  className="canvas-document-reading text-sm leading-relaxed [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_p+p]:mt-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/30 [&_pre]:p-3"
                />
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/20 p-4 text-sm">{payload.preview.candidate}</pre>
              )}
            </div>
          </TabsContent>
          <TabsContent value="source" className="min-h-0 overflow-auto p-3 sm:p-4">
            <SynchronizedPanes
              left={<SourceSide heading={t('currentVersion')} content={payload.preview.current} />}
              right={<SourceSide heading={selectedTitle} content={payload.preview.candidate ?? ''} candidate />}
              leftLabel={t('currentSourceLabel')}
              rightLabel={t('candidateSourceLabel')}
            />
          </TabsContent>
          <TabsContent value="details" className="min-h-0 overflow-auto p-4 sm:p-5">
            <ComparisonDetails payload={payload} entry={entry} />
          </TabsContent>
        </Tabs>
      )}
      <FileVersionActions
        request={request}
        current={current}
        entry={entry}
        reviewedProposalVersion={payload.actionFence.proposalVersion}
        reviewPending={reviewPending}
        candidateAvailable={!unavailable}
        restoreAllowed={restoreAllowed}
        onTimelineInvalidate={onTimelineInvalidate}
        onContinue={onContinue}
      />
    </div>
  );
}

function EmptyComparison({
  icon,
  title,
  description,
  action,
  testId,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-md">
        <span className="mx-auto flex size-10 items-center justify-center rounded-lg border bg-muted/35 text-muted-foreground">{icon}</span>
        <h2 className="mt-3 text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

export function FileVersionComparison({
  request,
  timeline,
  selection,
  onTimelineInvalidate,
  onContinue,
  isRevalidating = false,
  isStale = false,
}: {
  request: FileVersionCenterRequestV1;
  timeline: FileVersionTimelineResponseV1;
  selection: FileVersionTimelineSelection;
  onTimelineInvalidate: (action?: FileVersionMutation) => Promise<void> | void;
  onContinue: () => void;
  isRevalidating?: boolean;
  isStale?: boolean;
}) {
  const t = useTranslations('fileVersionCenter');
  const current = timeline.entries.find((entry) => entry.kind === 'current');
  const selected = selection.entry;
  const metadataOnly = selected?.kind === 'revision' && selected.content.availability === 'metadata_only';
  const identity = selected && selected.kind !== 'current'
    ? JSON.stringify([timeline.document.workspaceId, timeline.document.lineageId, timeline.document.documentId, selected.kind, selected.id])
    : 'empty';

  return (
    <main className="flex min-h-[24rem] min-w-0 flex-col bg-background md:min-h-0">
      {metadataOnly ? (
        <EmptyComparison
          testId="file-version-metadata-only"
          icon={<FileQuestion className="size-4" aria-hidden="true" />}
          title={t('metadataOnlyTitle')}
          description={t('metadataOnlyDescription')}
          action={(
            <Button type="button" variant="outline" size="sm" onClick={onContinue}>
              {t('actions.continue')}
            </Button>
          )}
        />
      ) : !timeline.capabilities.compare ? (
        <EmptyComparison
          icon={<FileQuestion className="size-4" aria-hidden="true" />}
          title={t('comparisonUnavailable')}
          description={t('comparisonUnavailableDescription')}
        />
      ) : selection.state === 'pending' ? (
        <EmptyComparison
          icon={<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          title={t('selectionPendingTitle')}
          description={t('selectionPending')}
        />
      ) : !current ? (
        <EmptyComparison
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
          title={t('currentUnavailable')}
          description={t('loadCurrentDescription')}
        />
      ) : !selected || selected.kind === 'current' ? (
        <EmptyComparison
          icon={<Columns2 className="size-4" aria-hidden="true" />}
          title={t('currentVersion')}
          description={t('selectionDescription')}
        />
      ) : (
        <LoadedComparison
          key={identity}
          request={request}
          current={current}
          entry={selected}
          restoreAllowed={timeline.capabilities.restore}
          lineageId={timeline.document.lineageId}
          timelineRefreshing={isRevalidating}
          timelineStale={isStale}
          onTimelineInvalidate={onTimelineInvalidate}
          onContinue={onContinue}
        />
      )}
    </main>
  );
}
