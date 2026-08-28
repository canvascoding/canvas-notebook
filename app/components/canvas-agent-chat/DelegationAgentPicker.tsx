'use client';

import { CheckCircle2, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AgentAvatar, AgentIcon } from '@/app/components/agents/AgentAvatar';
import type { DelegationOptions } from '@/app/lib/chat/delegation-api';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  const [open, setOpen] = useState(false);
  const selectedAgent = agents.find((agent) => agent.agentId === value) || agents[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="delegation-agent-picker"
          aria-label={t('delegationSelectAgent')}
          className="flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg border border-input bg-background px-2.5 text-left shadow-xs transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground">
            <AgentIcon iconId={selectedAgent?.iconId} className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {selectedAgent?.name || t('delegationSelectAgent')}
            </span>
            {selectedAgent ? (
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {selectedAgent.agentId}
              </span>
            ) : null}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[120] w-[var(--radix-popover-trigger-width)] min-w-64 p-1"
      >
        <div className="max-h-64 overflow-y-auto">
          {agents.map((agent) => {
            const selected = agent.agentId === selectedAgent?.agentId;
            return (
              <button
                key={agent.agentId}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onValueChange(agent.agentId);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                )}
              >
                <AgentAvatar iconId={agent.iconId} className="h-9 w-9" iconClassName="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{agent.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">{agent.agentId}</span>
                </span>
                {selected ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
