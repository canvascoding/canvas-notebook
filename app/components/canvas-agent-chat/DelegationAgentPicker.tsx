'use client';

import { CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import type { DelegationOptions } from '@/app/lib/chat/delegation-api';
import { cn } from '@/lib/utils';

type DelegationAgent = DelegationOptions['agents'][number];

export function DelegationAgentPicker({
  agents,
  value,
  onValueChange,
}: {
  agents: DelegationAgent[];
  value: string;
  onValueChange: (agentId: string) => void;
}) {
  const t = useTranslations('chat');
  const radioName = `delegation-target-agent-${useId()}`;

  return (
    <div
      role="radiogroup"
      aria-label={t('delegationSelectAgent')}
      data-testid="delegation-agent-picker"
      className="grid gap-2 sm:grid-cols-2"
    >
      {agents.map((agent) => {
        const selected = agent.agentId === value;
        return (
          <label
            key={agent.agentId}
            className={cn(
              'group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 text-left transition-[border-color,background-color,box-shadow] focus-within:ring-2 focus-within:ring-ring',
              selected
                ? 'border-primary/50 bg-primary/[0.07] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.08)]'
                : 'border-border/70 bg-background hover:border-primary/30 hover:bg-accent/40',
            )}
          >
            <input
              type="radio"
              name={radioName}
              value={agent.agentId}
              checked={selected}
              onChange={() => onValueChange(agent.agentId)}
              className="sr-only"
            />
            <AgentAvatar iconId={agent.iconId} className="h-9 w-9" iconClassName="h-4 w-4" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{agent.name}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">{agent.agentId}</span>
            </span>
            <span className={cn(
              'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-transparent',
            )}>
              <CheckCircle2 className="h-3 w-3" />
            </span>
          </label>
        );
      })}
    </div>
  );
}
