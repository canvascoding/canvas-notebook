'use client';

import { CheckCircle2, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

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
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedAgent = agents.find((agent) => agent.agentId === value) || agents[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
  }, [open]);

  return (
    <div ref={pickerRef} className="relative">
      <div>
        <button
          type="button"
          data-testid="delegation-agent-picker"
          aria-label={t('delegationSelectAgent')}
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
          className="flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg border border-input bg-background px-2.5 text-left shadow-xs transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AgentAvatar iconId={selectedAgent?.iconId} className="h-7 w-7" iconClassName="h-3.5 w-3.5" />
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
      </div>
      {open ? (
        <div
          role="listbox"
          aria-label={t('delegationSelectAgent')}
          className="absolute inset-x-0 top-[calc(100%+0.25rem)] z-20 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          {agents.map((agent) => {
            const selected = agent.agentId === selectedAgent?.agentId;
            return (
              <button
                key={agent.agentId}
                type="button"
                role="option"
                aria-selected={selected}
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
      ) : null}
    </div>
  );
}
