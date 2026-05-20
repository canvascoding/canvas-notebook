'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

type DiscoveryModel = {
  id: string;
  name: string;
  supportsVision?: boolean;
  reasoning?: boolean;
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

const THINKING_LEVELS: Array<{ value: PiThinkingLevel; label: string; menuOnly?: boolean }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

const PRIMARY_THINKING_LEVELS = THINKING_LEVELS.filter((level) => (
  level.value === 'low' || level.value === 'medium' || level.value === 'high' || level.value === 'xhigh'
));

function getThinkingLabel(value: PiThinkingLevel): string {
  return THINKING_LEVELS.find((level) => level.value === value)?.label || value;
}

function getModelShortLabel(modelName: string): string {
  const compactGpt = modelName.match(/^gpt-?(\d+(?:\.\d+)?)/iu);
  if (compactGpt) {
    return compactGpt[1];
  }

  return modelName.replace(/^GPT-/iu, '');
}

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
  const activeModelShortName = getModelShortLabel(activeModelName);
  const thinkingLabel = getThinkingLabel(thinkingLevel);
  const providerSupportsThinking = models.some((model) => model.reasoning);
  const canChange = !disabled && !pending;
  const visibleThinkingLevels = useMemo(() => {
    if (PRIMARY_THINKING_LEVELS.some((level) => level.value === thinkingLevel)) {
      return PRIMARY_THINKING_LEVELS;
    }

    const currentLevel = THINKING_LEVELS.find((level) => level.value === thinkingLevel);
    return currentLevel ? [currentLevel, ...PRIMARY_THINKING_LEVELS] : PRIMARY_THINKING_LEVELS;
  }, [thinkingLevel]);

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = setTimeout(() => setSaved(false), 1400);
    return () => clearTimeout(timer);
  }, [saved]);

  async function patchDefaultConfig(next: { model: string; thinkingLevel: PiThinkingLevel }) {
    const response = await fetch('/api/agents/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: activeProvider,
        model: next.model,
        thinkingLevel: next.thinkingLevel,
        makeActiveProvider: true,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      throw new Error(payload?.error || 'Model switch failed');
    }
  }

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
      setPending(true);
      setError(null);
      try {
        await patchDefaultConfig({ model: nextModel, thinkingLevel: nextThinkingLevel });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Model switch failed');
        setPending(false);
        return;
      }
      onModelChange({
        model: nextModel,
        thinkingLevel: nextThinkingLevel,
        provider: activeProvider,
      });
      setSaved(true);
      setPending(false);
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
    <div className="flex min-w-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!canChange}>
          <button
            type="button"
            data-testid="chat-model-selector"
            title={error || `${activeProvider} / ${activeModelName} / ${thinkingLabel}`}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 border border-border/60 bg-muted/60 text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
              compact ? 'max-w-[220px] px-2.5 py-1 text-xs' : 'max-w-[320px] px-3 py-1 text-xs',
              error && 'border-destructive/40 bg-destructive/10 text-destructive',
            )}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : null}
            <span className="min-w-0 truncate font-mono">{activeModelShortName}</span>
            {providerSupportsThinking ? (
              <span className="min-w-0 truncate text-muted-foreground">{thinkingLabel}</span>
            ) : null}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-[min(88vw,310px)] rounded-2xl bg-popover/95 p-2 shadow-2xl backdrop-blur">
          {providerSupportsThinking ? (
            <>
              <DropdownMenuLabel className="px-3 pb-1 pt-1 text-base font-medium text-muted-foreground">
                Intelligence
              </DropdownMenuLabel>
              {visibleThinkingLevels.map((level) => (
                <DropdownMenuItem
                  key={level.value}
                  onSelect={() => void patchSession({ thinkingLevel: level.value })}
                  className="flex min-h-11 items-center rounded-lg px-3 text-base"
                >
                  <span>{level.label}</span>
                  {thinkingLevel === level.value ? <Check className="ml-auto h-5 w-5 text-muted-foreground" /> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="mx-3 my-2" />
            </>
          ) : null}

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-11 rounded-lg px-3 text-base">
              <span className="min-w-0 truncate">{activeModelName}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[min(88vw,300px)] rounded-2xl bg-popover/95 p-2 shadow-2xl backdrop-blur">
              <DropdownMenuLabel className="px-3 pb-1 pt-1 text-base font-medium text-muted-foreground">
                Model
              </DropdownMenuLabel>
              {models.length > 0 ? models.map((model) => (
                <DropdownMenuItem
                  key={model.id}
                  onSelect={() => void patchSession({ model: model.id })}
                  className="flex min-h-11 items-center rounded-lg px-3 text-base"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{model.name}</span>
                    {model.id !== model.name ? (
                      <span className="block truncate font-mono text-xs text-muted-foreground">{model.id}</span>
                    ) : null}
                  </span>
                  {activeModel === model.id ? <Check className="ml-auto h-5 w-5 text-muted-foreground" /> : null}
                </DropdownMenuItem>
              )) : (
                <DropdownMenuItem disabled className="min-h-11 rounded-lg px-3 text-base">
                  <span className="truncate font-mono">{activeModel}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-2 text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
            <span className="truncate">{activeProvider}</span>
            {saved ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : null}
          </div>
          {error ? (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-[11px] text-destructive">{error}</div>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
