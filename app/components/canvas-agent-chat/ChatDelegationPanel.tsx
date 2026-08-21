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

import {
  cancelChatDelegation,
  fetchChatDelegations,
  fetchDelegationOptions,
  startChatDelegation,
  type ChatDelegation,
  type DelegationOptions,
} from '@/app/lib/chat/delegation-api';
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

export function ChatDelegationPanel({ sourceSessionId }: { sourceSessionId: string }) {
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

  const toggleResult = useCallback((id: string) => {
    setExpandedResultIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
          onClick={() => setExpanded((current) => !current)}
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
            const workerLabel = task.targetAgentId
              ? task.targetAgentId
              : task.workerRole || t('delegationEphemeralWorker');
            const result = task.resultText || task.errorText;

            return (
              <div
                key={task.id}
                data-testid="chat-delegation-item"
                data-status={task.status}
                className="border-b border-border/60 px-2.5 py-2 last:border-b-0"
              >
                <div className="flex items-start gap-2">
                  <TaskStatusIcon task={task} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground" title={task.goal}>{task.goal}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                      <span className={statusTone(task)}>{t(statusKey)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{workerLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{timeFormatter.format(new Date(task.createdAt))}</span>
                    </div>
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('delegationStart')}</DialogTitle>
            <DialogDescription>{t('delegationStartDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            {optionsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('delegationStarting')}
              </div>
            ) : delegationOptions ? (
              <>
                {delegationOptions.agents.length > 0 ? (
                  <label className="grid gap-1.5 text-sm font-medium">
                    {t('delegationTarget')}
                    <select
                      value={targetAgentId}
                      onChange={(event) => setTargetAgentId(event.target.value)}
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {delegationOptions.agents.map((agent) => (
                        <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('delegationNoAgents')}</p>
                )}

                <label className="grid gap-1.5 text-sm font-medium">
                  {t('delegationGoal')}
                  <Input value={goal} onChange={(event) => setGoal(event.target.value)} disabled={delegationOptions.agents.length === 0} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  {t('delegationContext')}
                  <Textarea value={context} onChange={(event) => setContext(event.target.value)} disabled={delegationOptions.agents.length === 0} />
                </label>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">{t('delegationTools')}</legend>
                  <div className="grid gap-1.5">
                    {delegationOptions.toolsets.map((toolset) => (
                      <label key={toolset.name} className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={selectedToolsets.has(toolset.name)}
                          onChange={() => toggleToolset(toolset.name)}
                          className="mt-0.5 h-3.5 w-3.5 accent-primary"
                        />
                        <span><span className="font-medium text-foreground">{toolset.label}</span> · {toolset.description}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </>
            ) : null}
            {startError ? <p className="text-sm text-destructive">{startError}</p> : null}
          </div>

          <DialogFooter>
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
