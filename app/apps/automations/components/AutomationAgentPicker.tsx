'use client';

import { useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { AutomationPickerContent } from './AutomationPickerContent';
import { Button } from '@/components/ui/button';
import { Popover as PopoverPrimitive } from 'radix-ui';

export type AutomationAgentOption = { agentId: string; name: string; iconId?: string };

export function AutomationAgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: AutomationAgentOption[];
  value: string;
  onChange: (agentId: string) => void;
}) {
  const t = useTranslations('automationen.ux');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = agents.find((agent) => agent.agentId === value);
  const visible = agents.filter((agent) =>
    agent.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('agent')}</p>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={t('chooseAgent')}
            aria-haspopup="dialog"
            className="h-12 w-full justify-start gap-3 px-3"
            data-testid="automation-agent-picker"
          >
            <AgentAvatar iconId={selected?.iconId} className="h-8 w-8 shrink-0" iconClassName="h-4 w-4" />
            <span className="min-w-0 flex-1 truncate text-left">
              {selected?.name || t('agentUnavailable')}
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </Button>
        </PopoverPrimitive.Trigger>
        <AutomationPickerContent
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          align="start"
          role="dialog"
          aria-label={t('chooseAgent')}
          className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] p-2"
        >
          <label className="flex items-center gap-2 border-b px-2 pb-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              className="h-9 w-full bg-transparent text-sm outline-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchAgents')}
              aria-label={t('searchAgents')}
            />
          </label>
          <div className="max-h-72 overflow-y-auto py-1">
            {visible.map((agent) => (
              <button
                type="button"
                key={agent.agentId}
                aria-pressed={agent.agentId === value}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onChange(agent.agentId);
                  setOpen(false);
                }}
              >
                <AgentAvatar iconId={agent.iconId} className="h-9 w-9 shrink-0" iconClassName="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.name}</span>
                {agent.agentId === value ? <Check className="h-4 w-4 text-primary" /> : null}
              </button>
            ))}
            {visible.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{t('noAgents')}</p>
            ) : null}
          </div>
        </AutomationPickerContent>
      </PopoverPrimitive.Root>
    </div>
  );
}
