'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, CheckCircle2, CircleDashed, Loader2, Network, RotateCw, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { SubagentIcon } from '@/app/components/agents/SubagentIcon';
import { formatRunDuration } from '@/app/lib/chat/run-collapse';
import { isTerminalDelegationStatus } from '@/app/lib/chat/delegation-inline';
import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import type { AgentProfile } from '@/app/lib/chat/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type DelegationDetail = {
  id: string;
  workerSessionId: string;
  workerType: 'ephemeral' | 'managed';
  targetAgentId: string | null;
  goal: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  resultText: string | null;
  errorText: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type ProgressResponse = {
  delegation: {
    id: string;
    status: DelegationDetail['status'];
    displayStatus: DelegationDetail['status'] | 'interrupted' | 'unknown';
    revision: number;
  };
  events: Array<{
    revision: number;
    kind: string;
    preview: string | null;
  }>;
  transcript: Array<{
    sequence: number;
    role: 'user' | 'assistant' | 'toolResult';
    toolNames: string[];
    isError: boolean;
  }>;
};

const POLL_INTERVAL_MS = 12_000;

export function InlineDelegationCard({
  delegationId,
  sourceSessionId,
  agents,
}: {
  delegationId: string;
  sourceSessionId: string;
  agents: AgentProfile[];
}) {
  const t = useTranslations('chat');
  const [detail, setDetail] = useState<DelegationDetail | null>(null);
  const [displayStatus, setDisplayStatus] = useState<ProgressResponse['delegation']['displayStatus'] | null>(null);
  const [lastEvent, setLastEvent] = useState<ProgressResponse['events'][number] | null>(null);
  const [transcript, setTranscript] = useState<ProgressResponse['transcript']>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastRevisionRef = useRef(0);
  const activeRef = useRef(true);
  const inFlightRef = useRef(false);
  const transcriptOpenRef = useRef(false);

  const detailUrl = useMemo(() => {
    const query = new URLSearchParams({ sourceSessionId });
    return `/api/delegations/${encodeURIComponent(delegationId)}?${query.toString()}`;
  }, [delegationId, sourceSessionId]);

  const loadDetail = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(detailUrl, { cache: 'no-store', signal });
    const payload = await safeFetchJson<{ success: boolean; delegation?: DelegationDetail }>(response);
    if (!response.ok || !payload?.success || payload.delegation?.id !== delegationId) throw new Error('Delegation unavailable.');
    if (!signal?.aborted) setDetail(payload.delegation);
  }, [delegationId, detailUrl]);

  const loadProgress = useCallback(async (includeTranscript: boolean, signal?: AbortSignal) => {
    const query = new URLSearchParams({
      sourceSessionId,
      afterRevision: String(lastRevisionRef.current),
      limit: '100',
      tailLimit: includeTranscript ? '24' : '0',
    });
    const response = await fetch(`/api/delegations/${encodeURIComponent(delegationId)}/progress?${query.toString()}`, {
      cache: 'no-store', signal,
    });
    const payload = await safeFetchJson<ProgressResponse & { success: boolean }>(response);
    if (!response.ok || !payload?.success || payload.delegation?.id !== delegationId) throw new Error('Progress unavailable.');
    if (signal?.aborted) return;
    const latest = payload.events.at(-1);
    if (latest && latest.revision > lastRevisionRef.current) {
      lastRevisionRef.current = latest.revision;
      const lastStep = payload.events.findLast((event) => (
        event.kind === 'tool_start' || event.kind === 'tool_end'
        || event.kind === 'compacting' || event.kind === 'resumed'
      ));
      if (lastStep) setLastEvent(lastStep);
    }
    if (includeTranscript) setTranscript(payload.transcript ?? []);
    setDisplayStatus(payload.delegation.displayStatus);
    activeRef.current = !isTerminalDelegationStatus(payload.delegation.status);
    if (!activeRef.current) await loadDetail(signal);
  }, [delegationId, loadDetail, sourceSessionId]);

  const refresh = useCallback(async (initial = false, includeTranscript = false, signal?: AbortSignal) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      if (initial) await loadDetail(signal);
      await loadProgress(includeTranscript, signal);
      if (!signal?.aborted) setLoadError(false);
    } catch {
      if (!signal?.aborted) setLoadError(true);
    } finally {
      inFlightRef.current = false;
      if (!signal?.aborted) setLoading(false);
    }
  }, [loadDetail, loadProgress]);

  useEffect(() => {
    const controller = new AbortController();
    lastRevisionRef.current = 0;
    activeRef.current = true;
    const initial = window.setTimeout(() => void refresh(true, false, controller.signal), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && activeRef.current) {
        void refresh(false, transcriptOpenRef.current);
        setNow(Date.now());
      }
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(interval);
      inFlightRef.current = false;
    };
  }, [refresh]);

  const targetAgent = detail?.targetAgentId
    ? agents.find((agent) => agent.agentId === detail.targetAgentId)
    : null;
  const status = displayStatus ?? detail?.status ?? null;
  const statusKey = status === 'queued' ? 'delegationStatusQueued'
    : status === 'running' ? 'delegationStatusRunning'
      : status === 'completed' ? 'delegationStatusCompleted'
        : status === 'failed' ? 'delegationStatusFailed'
          : status === 'cancelled' ? 'delegationStatusCancelled'
            : status === 'interrupted' ? 'delegationInlineInterrupted'
              : 'delegationInlineUnknown';
  const active = status === 'queued' || status === 'running';
  const durationStart = detail ? Date.parse(detail.startedAt || detail.createdAt) : NaN;
  const durationEnd = detail?.completedAt ? Date.parse(detail.completedAt) : now;
  const duration = Number.isFinite(durationStart) && Number.isFinite(durationEnd)
    ? formatRunDuration(durationStart, durationEnd)
    : null;
  const latestStep = lastEvent?.kind === 'tool_start' || lastEvent?.kind === 'tool_end'
    ? `${t(lastEvent.kind === 'tool_start' ? 'delegationInlineToolStart' : 'delegationInlineToolEnd')}: ${lastEvent.preview || t('delegationInlineUnknownTool')}`
    : lastEvent?.kind === 'compacting' ? t('delegationInlineCompacting')
      : lastEvent?.kind === 'resumed' ? t('delegationInlineResumed')
        : null;

  const jumpToPanel = () => {
    const row = document.getElementById(`chat-delegation-${delegationId}`);
    const target = row || document.getElementById('chat-delegation-panel');
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    target?.focus();
  };

  const toggleTranscript = () => {
    const next = !transcriptOpen;
    transcriptOpenRef.current = next;
    setTranscriptOpen(next);
    if (next) void refresh(false, true);
  };

  return (
    <section
      data-testid="chat-inline-delegation"
      data-delegation-id={delegationId}
      data-status={status ?? 'loading'}
      className="my-1 w-full max-w-[90%] rounded-lg border border-border/70 bg-background/95 p-3 shadow-sm"
      aria-label={t('delegations')}
    >
      <div className="flex items-start gap-2.5">
        {detail?.workerType === 'managed' ? (
          <AgentAvatar iconId={targetAgent?.iconId} className="h-9 w-9 rounded-lg" iconClassName="h-4 w-4" />
        ) : (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted" aria-hidden="true">
            <SubagentIcon className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground" title={detail?.goal}>
              {detail?.goal || delegationId.slice(0, 12)}
            </p>
            {active ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" aria-hidden="true" />
              : status === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                : status === 'failed' ? <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                  : status === 'cancelled' ? <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    : <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            <span>{targetAgent?.name || detail?.targetAgentId || t('delegationEphemeralWorker')}</span>
            <span aria-hidden="true">·</span>
            <span className={cn(status === 'failed' && 'text-destructive', status === 'completed' && 'text-emerald-600')}>
              {status ? t(statusKey) : t('delegationInlineLoading')}
            </span>
            {duration ? <><span aria-hidden="true">·</span><span>{duration}</span></> : null}
          </div>
          {latestStep ? <p className="mt-1 text-[11px] text-muted-foreground">{latestStep}</p> : null}
          {detail?.resultText || detail?.errorText ? (
            <p className={cn('mt-2 line-clamp-3 text-xs leading-relaxed', detail.status === 'failed' ? 'text-destructive' : 'text-foreground/80')}>
              {detail.resultText || detail.errorText}
            </p>
          ) : null}
          {loadError ? (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
              <span>{t('delegationLoadFailed')}</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => void refresh(!detail, transcriptOpen)}>
                <RotateCw className="h-3 w-3" />{t('delegationRetry')}
              </Button>
            </div>
          ) : null}
          {!loading && !loadError ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button type="button" variant="outline" size="xs" data-testid="chat-inline-delegation-history-toggle" aria-expanded={transcriptOpen} onClick={toggleTranscript}>
                <Network className="h-3 w-3" />{t('delegationInlineViewHistory')}
              </Button>
              <Button type="button" variant="ghost" size="xs" data-testid="chat-inline-delegation-manage" onClick={jumpToPanel}>
                {t(detail?.status === 'completed' && detail.workerType === 'managed' ? 'delegationInlineFollowUp' : 'delegationInlineManage')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {transcriptOpen ? (
        <div data-testid="chat-inline-delegation-tail" className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {transcript.length === 0 ? <p className="text-[11px] text-muted-foreground">{t('delegationInlineNoHistory')}</p> : null}
          {transcript.map((entry) => (
            <p key={entry.sequence} className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">{entry.role === 'toolResult' ? t('delegationInlineToolResult') : entry.role === 'assistant' ? t('delegationInlineAssistant') : t('delegationInlineUser')}</span>
              {entry.toolNames.length ? ` · ${entry.toolNames.join(', ')}` : ''}
              {entry.isError ? ` · ${t('delegationStatusFailed')}` : ''}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
