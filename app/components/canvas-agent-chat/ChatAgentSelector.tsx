'use client';

import { CheckCircle2, ChevronDown, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar, AgentIcon } from '@/app/components/agents/AgentAvatar';
import type { AgentProfile } from '@/app/lib/chat/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export function ChatAgentSelector({
  variant,
  activeAgentId,
  activeAgentName,
  activeAgentIconId,
  agents,
  onSelectAgent,
}: {
  variant: 'desktop' | 'mobile';
  activeAgentId: string;
  activeAgentName: string;
  activeAgentIconId?: string | null;
  agents: AgentProfile[];
  onSelectAgent: (agentId: string) => void;
}) {
  const t = useTranslations('chat');
  const compact = variant === 'mobile';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-agent-id"
          aria-label={`${t('agentSelectTitle')}: ${activeAgentName}`}
          title={t('agentSelectTitle')}
          className={cn(
            'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 font-medium text-foreground transition-colors hover:bg-accent',
            compact ? 'max-w-[12rem] text-[10px]' : 'max-w-[min(14rem,100%)] text-[11px]',
          )}
        >
          {!compact ? (
            <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{t('agentLabel')}</span>
          ) : null}
          <AgentIcon iconId={activeAgentIconId} className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={cn('min-w-0 truncate', compact ? 'max-w-[8rem]' : 'max-w-[9rem]')}>
            {activeAgentName}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-64 p-1">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <div className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t('agentSelectTitle')}
          </div>
          <Link
            href="/settings?tab=agent-settings&createAgent=1"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t('createAgent')}
            aria-label={t('createAgent')}
          >
            <Plus className="h-4 w-4" />
          </Link>
        </div>
        {agents.map((agent) => {
          const selected = agent.agentId === activeAgentId;
          return (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => onSelectAgent(agent.agentId)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
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
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
