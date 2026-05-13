'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Cpu, Loader2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

type DiscoveryModel = {
  id: string;
  name: string;
  supportsVision?: boolean;
};

type AgentConfig = {
  piConfig: {
    activeProvider: string;
    providers: Record<string, { model: string; thinking?: PiThinkingLevel }>;
  };
  discovery: Record<string, { models: DiscoveryModel[] }>;
};

type ChatModelSelectorProps = {
  sessionId: string | null;
  activeModel: string;
  activeProvider: string;
  thinkingLevel: PiThinkingLevel;
  agentConfig: AgentConfig | null;
  disabled?: boolean;
  compact?: boolean;
  onModelChange: (next: {
    model: string;
    thinkingLevel: PiThinkingLevel;
    provider: string;
  }) => void;
  onRuntimeInvalidated?: () => Promise<void> | void;
};

const THINKING_LEVELS: Array<{ value: PiThinkingLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

export function ChatModelSelector({
  sessionId,
  activeModel,
  activeProvider,
  thinkingLevel,
  agentConfig,
  disabled = false,
  compact = false,
  onModelChange,
  onRuntimeInvalidated,
}: ChatModelSelectorProps) {
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = useMemo(() => {
    return agentConfig?.discovery?.[activeProvider]?.models || [];
  }, [activeProvider, agentConfig]);

  const activeModelName = models.find((model) => model.id === activeModel)?.name || activeModel;
  const canChange = !disabled && !pending;

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = setTimeout(() => setSaved(false), 1400);
    return () => clearTimeout(timer);
  }, [saved]);

  async function patchSession(next: { model?: string; thinkingLevel?: PiThinkingLevel }) {
    if (pending) {
      return;
    }

    const nextModel = next.model || activeModel;
    const nextThinkingLevel = next.thinkingLevel || thinkingLevel;
    if (nextModel === activeModel && nextThinkingLevel === thinkingLevel) {
      return;
    }

    if (!sessionId) {
      onModelChange({
        model: nextModel,
        thinkingLevel: nextThinkingLevel,
        provider: activeProvider,
      });
      setSaved(true);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          model: nextModel,
          thinkingLevel: nextThinkingLevel,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || 'Model switch failed');
      }

      await onRuntimeInvalidated?.();
      onModelChange({
        model: payload.session?.model || nextModel,
        thinkingLevel: (payload.session?.thinkingLevel || nextThinkingLevel) as PiThinkingLevel,
        provider: payload.session?.provider || activeProvider,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Model switch failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!canChange}>
        <button
          type="button"
          data-testid="chat-model-selector"
          title={error || `${activeProvider} / ${activeModelName} / ${thinkingLevel}`}
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 border border-border/60 bg-muted/40 text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'max-w-[220px] px-2 py-0.5 text-[10px]' : 'max-w-[320px] px-2.5 py-0.5 text-[10px]',
            error && 'border-destructive/40 bg-destructive/10 text-destructive',
          )}
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : saved ? <Check className="h-3 w-3 text-emerald-500" /> : <Cpu className="h-3 w-3 text-muted-foreground" />}
          <span className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">Model</span>
          <span className="min-w-0 truncate font-mono text-[9px]">{activeModelName}</span>
          <span className="shrink-0 border-l border-border/60 pl-1 font-mono text-[9px] text-muted-foreground">{thinkingLevel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(88vw,340px)]">
        <DropdownMenuLabel className="flex items-center justify-between gap-3 text-[11px]">
          <span className="truncate uppercase tracking-[0.15em] text-muted-foreground">{activeProvider}</span>
          {saved ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : null}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeModel}
          onValueChange={(model) => void patchSession({ model })}
        >
          {models.length > 0 ? models.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id} className="items-start py-2">
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{model.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">{model.id}</span>
              </span>
            </DropdownMenuRadioItem>
          )) : (
            <DropdownMenuRadioItem value={activeModel} disabled className="py-2">
              <span className="truncate font-mono text-xs">{activeModel}</span>
            </DropdownMenuRadioItem>
          )}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
          Thinking
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={thinkingLevel}
          onValueChange={(value) => void patchSession({ thinkingLevel: value as PiThinkingLevel })}
        >
          {THINKING_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level.value} value={level.value} className="py-1.5 text-xs">
              {level.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {error ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[11px] text-destructive">{error}</div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
