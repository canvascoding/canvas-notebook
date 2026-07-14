'use client';

import { useCallback, useState } from 'react';
import { CheckCircle2, ChevronDown, Pencil, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar, AgentIcon } from '@/app/components/agents/AgentAvatar';
import { EditAgentProfileDialog } from '@/app/components/agents/EditAgentProfileDialog';
import { authClient } from '@/app/lib/auth-client';
import type { AgentProfile } from '@/app/lib/chat/types';
import { CreateAgentDialog, type CreateAgentInput } from '@/app/components/settings/CreateAgentDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function ChatAgentSelector({
  variant,
  activeAgentId,
  activeAgentName,
  activeAgentIconId,
  agents,
  className,
  testId = 'chat-agent-id',
  onSelectAgent,
  onReloadAgents,
  iconOnly = false,
  adaptiveMobileLabel = false,
}: {
  variant: 'desktop' | 'mobile' | 'compact';
  activeAgentId: string;
  activeAgentName: string;
  activeAgentIconId?: string | null;
  agents: AgentProfile[];
  className?: string;
  testId?: string;
  onSelectAgent: (agentId: string) => void;
  onReloadAgents?: () => Promise<void>;
  iconOnly?: boolean;
  adaptiveMobileLabel?: boolean;
}) {
  const t = useTranslations('chat');
  const compact = variant === 'mobile' || variant === 'compact';
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentProfile | null>(null);
  const { data: session } = authClient.useSession();
  const canManageAgentDefaults = session?.user?.role === 'admin';

  const createAgent = useCallback(async (input: CreateAgentInput): Promise<boolean> => {
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { agent?: AgentProfile };
        error?: string;
      };
      const createdAgent = payload.data?.agent;
      if (!response.ok || !payload.success || !createdAgent) {
        throw new Error(payload.error || t('agentCreateFailed'));
      }

      await onReloadAgents?.();
      onSelectAgent(createdAgent.agentId);
      return true;
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t('agentCreateFailed'));
      return false;
    } finally {
      setCreating(false);
    }
  }, [onReloadAgents, onSelectAgent, t]);

  const handleAgentChanged = useCallback(async () => {
    await onReloadAgents?.();
  }, [onReloadAgents]);

  const isMobileSelector = variant === 'mobile';
  const shouldAdaptMobileLabel = adaptiveMobileLabel && isMobileSelector;

  return (
    <>
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={`${t('agentSelectTitle')}: ${activeAgentName}`}
          title={t('agentSelectTitle')}
          className={cn(
            'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-medium text-foreground transition-colors hover:bg-accent',
            iconOnly
              ? 'w-auto justify-center border-border/60'
              : 'border-border/60 bg-muted/50',
            !iconOnly && (variant === 'mobile'
              ? 'max-w-[12rem] text-[10px]'
              : compact
                ? 'max-w-[9rem] text-[10px]'
                : 'max-w-[min(14rem,100%)] text-[11px]'),
            className,
          )}
        >
          {!compact && !iconOnly ? (
            <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('agentLabel')}</span>
          ) : null}
          <AgentIcon iconId={activeAgentIconId} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {!iconOnly ? (
            <span className={cn(
              'min-w-0 truncate',
              shouldAdaptMobileLabel
                ? 'hidden @[17rem]:block @[17rem]:max-w-[8rem]'
                : compact
                  ? 'max-w-[6rem]'
                  : 'max-w-[9rem]',
            )}>
              {activeAgentName}
            </span>
          ) : null}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        data-testid="chat-agent-selector-popover"
        className="z-[110] w-64 p-1"
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <div className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t('agentSelectTitle')}
          </div>
          <button
            type="button"
            onClick={() => {
              setCreateError(null);
              setPopoverOpen(false);
              setCreateDialogOpen(true);
            }}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t('createAgent')}
            aria-label={t('createAgent')}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {agents.map((agent) => {
          const selected = agent.agentId === activeAgentId;
          return (
            <div key={agent.agentId} className="group flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onSelectAgent(agent.agentId)}
                className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                  selected ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                }`}
              >
                <AgentAvatar iconId={agent.iconId} className="h-9 w-9" iconClassName="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{agent.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{agent.agentId}</span>
                </span>
                {selected ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : null}
              </button>
              {agent.removable ? (
                <button
                  type="button"
                  onClick={() => {
                    setPopoverOpen(false);
                    setEditTarget(agent);
                  }}
                  className={cn(
                    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    !isMobileSelector && 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100',
                  )}
                  title={t('editAgent', { name: agent.name })}
                  aria-label={t('editAgent', { name: agent.name })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
    <CreateAgentDialog
      open={createDialogOpen}
      creating={creating}
      error={createError}
      canManageAgentDefaults={canManageAgentDefaults}
      onOpenChange={(open) => {
        setCreateDialogOpen(open);
        if (!open) setCreateError(null);
      }}
      onCreate={createAgent}
    />
    <EditAgentProfileDialog
      open={Boolean(editTarget)}
      agent={editTarget}
      onOpenChange={(open) => {
        if (!open) setEditTarget(null);
      }}
      onChanged={handleAgentChanged}
    />
    </>
  );
}
