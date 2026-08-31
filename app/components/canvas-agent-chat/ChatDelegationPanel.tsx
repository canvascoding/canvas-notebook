'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Network,
  Plus,
  RotateCw,
  XCircle,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { DelegationAgentPicker } from '@/app/components/canvas-agent-chat/DelegationAgentPicker';
import { DelegationToolsetIcon } from '@/app/components/canvas-agent-chat/DelegationToolsetIcon';
import { DelegationToolsetPicker } from '@/app/components/canvas-agent-chat/DelegationToolsetPicker';
import {
  cancelChatDelegation,
  fetchChatDelegations,
  fetchDelegationOptions,
  startChatDelegation,
  type ChatDelegation,
  type DelegationOptions,
} from '@/app/lib/chat/delegation-api';
import {
  readChatDelegationPanelExpanded,
  writeChatDelegationPanelExpanded,
} from '@/app/lib/chat/delegation-panel-storage';
import type { AgentProfile } from '@/app/lib/chat/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 3_000;

function isActive(task: ChatDelegation): boolean {
  return task.status === 'queued' || task.status === 'running';
}

function statusTone(task: ChatDelegation): string {
  if (task.cancelRequestedAt) return 'text-amber-600 dark:text-amber-400';
  if (task.status === 'completed') return 'text-emerald-600 dark:text-emerald-400';
  if (task.status === 'failed') return 'text-destructive';
  if (task.status === 'cancelled') return 'text-muted-foreground';
  return 'text-blue-600 dark:text-blue-400';
}

function TaskStatusIcon({ task }: { task: ChatDelegation }) {
  const className = cn('h-4 w-4 shrink-0', statusTone(task));
  if (task.cancelRequestedAt) return <Loader2 className={cn(className, 'animate-spin')} />;
  if (task.status === 'queued') return <CircleDashed className={className} />;
  if (task.status === 'running') return <Loader2 className={cn(className, 'animate-spin')} />;
  if (task.status === 'completed') return <CheckCircle2 className={className} />;
  if (task.status === 'cancelled') return <Ban className={className} />;
  return <XCircle className={className} />;
}

export function ChatDelegationPanel({
  sourceSessionId,
  agents,
}: {
  sourceSessionId: string;
  agents: AgentProfile[];
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const [tasks, setTasks] = useState<ChatDelegation[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const [expandedResultIds, setExpandedResultIds] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [delegationOptions, setDelegationOptions] = useState<DelegationOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [targetAgentId, setTargetAgentId] = useState('');
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [selectedToolsets, setSelectedToolsets] = useState<Set<string>>(() => new Set());
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    const restoreExpandedState = window.setTimeout(() => {
      setExpanded(readChatDelegationPanelExpanded(window.localStorage));
    }, 0);
    return () => window.clearTimeout(restoreExpandedState);
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    try {
      const nextTasks = await fetchChatDelegations(sourceSessionId, signal);
      if (!signal?.aborted) {
        setTasks(nextTasks);
        setLoadError(null);
      }
    } catch {
      if (!signal?.aborted) {
        setLoadError(t('delegationLoadFailed'));
      }
    } finally {
      requestInFlightRef.current = false;
      if (!signal?.aborted) setLoading(false);
    }
  }, [sourceSessionId, t]);

  useEffect(() => {
    const controller = new AbortController();
    const initialRefresh = window.setTimeout(() => {
      void refresh(controller.signal);
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      requestInFlightRef.current = false;
    };
  }, [refresh]);

  const activeCount = useMemo(() => tasks.filter(isActive).length, [tasks]);
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents],
  );
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }), [locale]);

  const cancelTask = useCallback(async (id: string) => {
    setCancellingIds((current) => new Set(current).add(id));
    setTasks((current) => current.map((task) => (
      task.id === id ? { ...task, cancelRequestedAt: new Date().toISOString() } : task
    )));
    try {
      const cancelled = await cancelChatDelegation(id);
      setTasks((current) => current.map((task) => (
        task.id === id ? { ...task, ...cancelled } : task
      )));
      void refresh();
    } catch {
      setLoadError(t('delegationCancelFailed'));
      void refresh();
    } finally {
      setCancellingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [refresh, t]);

  const openStartDialog = useCallback(async () => {
    setDialogOpen(true);
    setStartError(null);
    setOptionsLoading(true);
    try {
      const options = await fetchDelegationOptions(sourceSessionId);
      setDelegationOptions(options);
      setTargetAgentId((current) => current || options.agents[0]?.agentId || '');
      setSelectedToolsets((current) => current.size > 0
        ? current
        : new Set(options.toolsets.map((toolset) => toolset.name)));
    } catch {
      setStartError(t('delegationOptionsFailed'));
    } finally {
      setOptionsLoading(false);
    }
  }, [sourceSessionId, t]);

  const submitDelegation = useCallback(async () => {
    if (!targetAgentId || !goal.trim()) return;
    setStarting(true);
    setStartError(null);
    try {
      await startChatDelegation({
        sourceSessionId,
        targetAgentId,
        goal: goal.trim(),
        context: context.trim() || undefined,
        toolsets: Array.from(selectedToolsets),
      });
      setDialogOpen(false);
      setGoal('');
      setContext('');
      void refresh();
    } catch {
      setStartError(t('delegationStartFailed'));
    } finally {
      setStarting(false);
    }
  }, [context, goal, refresh, selectedToolsets, sourceSessionId, t, targetAgentId]);

  const toggleToolset = useCallback((toolset: string) => {
    setSelectedToolsets((current) => {
      const next = new Set(current);
      if (next.has(toolset)) next.delete(toolset);
      else next.add(toolset);
      return next;
    });
  }, []);

  const selectAllToolsets = useCallback(() => {
    setSelectedToolsets(new Set(delegationOptions?.toolsets.map((toolset) => toolset.name) || []));
  }, [delegationOptions]);

  const clearToolsets = useCallback(() => {
    setSelectedToolsets(new Set());
  }, []);

  const toggleResult = useCallback((id: string) => {
    setExpandedResultIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      writeChatDelegationPanelExpanded(window.localStorage, next);
      return next;
    });
  }, []);

  return (
    <div
      data-testid="chat-delegation-panel"
      className="mb-2 overflow-hidden rounded-md border border-border/70 bg-background/95 shadow-sm"
    >
      <div className="flex items-center px-2.5 py-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs transition-colors hover:text-primary"
        >
          <Network className="h-4 w-4 text-primary" />
          <span className="font-medium text-foreground">{t('delegations')}</span>
          {activeCount > 0 ? (
            <Badge variant="secondary" className="h-5 border-blue-500/20 bg-blue-500/10 px-1.5 text-[10px] text-blue-700 dark:text-blue-300">
              {t('delegationActiveCount', { count: activeCount })}
            </Badge>
          ) : tasks.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">{t('delegationTaskCount', { count: tasks.length })}</span>
          ) : null}
          <span className="ml-auto text-muted-foreground">
            {loading && tasks.length === 0
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="chat-delegation-start"
          aria-label={t('delegationStart')}
          title={t('delegationStart')}
          onClick={() => void openStartDialog()}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {expanded ? (
        <div className="max-h-56 overflow-y-auto border-t border-border/60">
          {loadError ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-destructive">
              <span className="min-w-0 flex-1 truncate">{loadError}</span>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => void refresh()} title={t('delegationRetry')}>
                <RotateCw className="h-3 w-3" />
              </Button>
            </div>
          ) : null}

          {!loading && tasks.length === 0 && !loadError ? (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground">{t('delegationNoTasks')}</div>
          ) : null}

          {tasks.map((task) => {
            const canCancel = isActive(task) && !task.cancelRequestedAt;
            const statusKey = task.cancelRequestedAt
              ? 'delegationStatusCancelling'
              : task.status === 'queued'
                ? 'delegationStatusQueued'
                : task.status === 'running'
                  ? 'delegationStatusRunning'
                  : task.status === 'completed'
                    ? 'delegationStatusCompleted'
                    : task.status === 'cancelled'
                      ? 'delegationStatusCancelled'
                      : 'delegationStatusFailed';
            const workerAgent = task.targetAgentId ? agentsById.get(task.targetAgentId) : undefined;
            const workerLabel = workerAgent?.name
              || task.targetAgentId
              || task.workerRole
              || t('delegationEphemeralWorker');
            const visibleToolsets = task.toolsets.slice(0, 4);
            const result = task.resultText || task.errorText;

            return (
              <div
                key={task.id}
                data-testid="chat-delegation-item"
                data-status={task.status}
                className="border-b border-border/60 px-2.5 py-2 transition-colors last:border-b-0 hover:bg-muted/25"
              >
                <div className="flex items-start gap-2">
                  <span className="relative mt-0.5 shrink-0">
                    <AgentAvatar
                      iconId={workerAgent?.iconId}
                      className="h-8 w-8 rounded-lg bg-muted/70"
                      iconClassName="h-3.5 w-3.5"
                    />
                    <span className="absolute -bottom-1 -right-1 inline-flex rounded-full bg-background p-0.5 shadow-sm">
                      <TaskStatusIcon task={task} />
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground" title={task.goal}>{task.goal}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                      <span className={statusTone(task)}>{t(statusKey)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{workerLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{timeFormatter.format(new Date(task.createdAt))}</span>
                    </div>
                    {visibleToolsets.length > 0 ? (
                      <div
                        className="mt-1.5 flex items-center gap-1"
                        aria-label={t('delegationTools')}
                        title={task.toolsets.join(', ')}
                      >
                        {visibleToolsets.map((toolset) => (
                          <span
                            key={toolset}
                            className="inline-flex h-5 w-5 items-center justify-center rounded border border-border/70 bg-muted/60 text-muted-foreground"
                          >
                            <DelegationToolsetIcon toolset={toolset} className="h-3 w-3" />
                          </span>
                        ))}
                        {task.toolsets.length > visibleToolsets.length ? (
                          <span className="text-[10px] text-muted-foreground">
                            +{task.toolsets.length - visibleToolsets.length}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {result ? (
                      <div className="mt-1">
                        <div className={cn(
                          'text-[11px] leading-relaxed',
                          !expandedResultIds.has(task.id) && 'line-clamp-2',
                          task.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                        )}>
                          {result}
                        </div>
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          onClick={() => toggleResult(task.id)}
                          className="h-auto px-0 py-0.5 text-[10px]"
                        >
                          {expandedResultIds.has(task.id) ? t('delegationHideResult') : t('delegationShowResult')}
                        </Button>
                      </div>
                    ) : null}
                    {task.deliveryStatus === 'failed' && task.deliveryErrorText ? (
                      <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        {t('delegationDeliveryPending')}
                      </div>
                    ) : null}
                  </div>
                  {canCancel ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={cancellingIds.has(task.id)}
                      onClick={() => void cancelTask(task.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {cancellingIds.has(task.id) ? <Loader2 className="animate-spin" /> : <Ban />}
                      {t('delegationCancel')}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex h-[min(92dvh,780px)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="shrink-0 border-b border-border/70 px-4 py-4 pr-12 sm:px-6">
            <DialogTitle>{t('delegationStart')}</DialogTitle>
            <DialogDescription>{t('delegationStartDescription')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="grid gap-5 px-4 py-4 sm:px-6">
              {optionsLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('delegationStarting')}
                </div>
              ) : delegationOptions ? (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-start">
                  <div className="grid content-start gap-4">
                    {delegationOptions.agents.length > 0 ? (
                      <div className="grid gap-1.5 text-sm font-medium">
                        <span>{t('delegationTarget')}</span>
                        <DelegationAgentPicker
                          agents={delegationOptions.agents}
                          value={targetAgentId}
                          onValueChange={setTargetAgentId}
                        />
                      </div>
                    ) : (
                      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
                        {t('delegationNoAgents')}
                      </p>
                    )}

                    <label className="grid gap-1.5 text-sm font-medium">
                      {t('delegationGoal')}
                      <Input value={goal} onChange={(event) => setGoal(event.target.value)} disabled={delegationOptions.agents.length === 0} />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      {t('delegationContext')}
                      <Textarea
                        value={context}
                        onChange={(event) => setContext(event.target.value)}
                        disabled={delegationOptions.agents.length === 0}
                        className="min-h-24 resize-y"
                      />
                    </label>
                  </div>
                  <div className="min-w-0 lg:border-l lg:border-border/70 lg:pl-5">
                    <DelegationToolsetPicker
                      toolsets={delegationOptions.toolsets}
                      selectedToolsets={selectedToolsets}
                      onToggle={toggleToolset}
                      onSelectAll={selectAllToolsets}
                      onClear={clearToolsets}
                    />
                  </div>
                </div>
              ) : null}
              {startError ? <p className="text-sm text-destructive">{startError}</p> : null}
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t border-border/70 bg-background/95 px-4 py-3 sm:px-6">
            <Button
              type="button"
              onClick={() => void submitDelegation()}
              disabled={optionsLoading || starting || !targetAgentId || !goal.trim() || selectedToolsets.size === 0}
            >
              {starting ? <Loader2 className="animate-spin" /> : null}
              {starting ? t('delegationStarting') : t('delegationSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
