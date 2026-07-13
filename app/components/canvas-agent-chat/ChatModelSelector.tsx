'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  ShieldCheck,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {
  AiCatalogModel,
  AiEffectiveCatalogProvider,
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
} from '@/app/lib/agent-runtime-policy/types';
import { patchChatSessions } from '@/app/lib/chat/session-api';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { cn } from '@/lib/utils';

type ChatModelSelectorProps = {
  agentId: string;
  sessionId: string | null;
  selection: AiRuntimeSelection | null;
  selectionSource: AiRuntimeSelectionSource | null;
  resolution: AiEffectiveRuntimeResolution | null;
  runtimeError?: string | null;
  hasLocalSelection?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onSelectionChange: (next: AiRuntimeSelection) => void;
  onResolutionChange?: (next: AiEffectiveRuntimeResolution) => void;
  onResolutionRefresh?: () => Promise<void> | void;
  onRuntimeStatusRefresh?: () => Promise<void> | void;
};

type SelectorFeedback = {
  contextKey: string;
  pending: boolean;
  saved: boolean;
  error: string | null;
};

const THINKING_LEVELS: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function getModelShortLabel(modelName: string): string {
  const normalized = modelName
    .replace(/\s+via\s+.+$/iu, '')
    .replace(/\s+on\s+.+$/iu, '')
    .trim();
  const compactGpt = normalized.match(/^gpt-?(\d+(?:\.\d+)?)/iu);
  if (compactGpt) return compactGpt[1];
  if (normalized.length > 24) return `${normalized.slice(0, 23).trimEnd()}...`;
  return normalized.replace(/^GPT-/iu, '');
}

function preferredThinkingLevel(
  model: AiCatalogModel,
  current: PiThinkingLevel | undefined,
): PiThinkingLevel {
  if (current && model.thinkingLevels.includes(current)) return current;
  if (model.thinkingLevels.includes('medium')) return 'medium';
  if (model.thinkingLevels.includes('off')) return 'off';
  return model.thinkingLevels[0] ?? 'off';
}

function providerForSelection(
  resolution: AiEffectiveRuntimeResolution | null,
  selection: AiRuntimeSelection | null,
): AiEffectiveCatalogProvider | null {
  if (!resolution || !selection) return null;
  return resolution.providers.find((provider) => (
    provider.installationId === selection.providerInstallationId
  )) ?? null;
}

function modelForSelection(
  provider: AiEffectiveCatalogProvider | null,
  selection: AiRuntimeSelection | null,
): AiCatalogModel | null {
  if (!provider || !selection) return null;
  return provider.models.find((model) => model.id === selection.modelId) ?? null;
}

function selectionIsValid(
  provider: AiEffectiveCatalogProvider | null,
  model: AiCatalogModel | null,
  selection: AiRuntimeSelection | null,
): boolean {
  return Boolean(
    provider?.selectable
      && model?.enabled
      && selection
      && provider.providerId === selection.providerId
      && model.thinkingLevels.includes(selection.thinkingLevel),
  );
}

export function ChatModelSelector({
  agentId,
  sessionId,
  selection,
  selectionSource,
  resolution,
  runtimeError = null,
  hasLocalSelection = false,
  disabled = false,
  compact = false,
  onSelectionChange,
  onResolutionChange,
  onResolutionRefresh,
  onRuntimeStatusRefresh,
}: ChatModelSelectorProps) {
  const t = useTranslations('chat');
  const contextKey = `${agentId}\0${sessionId ?? '__new__'}`;
  const latestContextKeyRef = useRef(contextKey);
  useLayoutEffect(() => {
    latestContextKeyRef.current = contextKey;
  }, [contextKey]);
  const [feedback, setFeedback] = useState<SelectorFeedback>({
    contextKey: '',
    pending: false,
    saved: false,
    error: null,
  });
  const currentFeedback = feedback.contextKey === contextKey
    ? feedback
    : { contextKey, pending: false, saved: false, error: null };

  const selectedProvider = useMemo(
    () => providerForSelection(resolution, selection),
    [resolution, selection],
  );
  const selectedModel = useMemo(
    () => modelForSelection(selectedProvider, selection),
    [selectedProvider, selection],
  );
  const validSelection = selectionIsValid(selectedProvider, selectedModel, selection);
  const providers = resolution?.providers ?? [];
  const models = selectedProvider?.models ?? [];
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const canChange = Boolean(resolution || runtimeError) && !disabled && !currentFeedback.pending;
  const issue = !hasLocalSelection ? resolution?.issues[0] : null;

  const issueMessage = issue ? ({
    RUNTIME_CATALOG_NOT_CONFIGURED: t('runtimeIssueCatalogNotConfigured'),
    NO_ALLOWED_MODELS: t('runtimeIssueNoAllowedModels'),
    PROVIDER_INSTALLATION_NOT_ALLOWED: t('runtimeIssueProviderNotAllowed'),
    PROVIDER_NOT_READY: t('runtimeIssueProviderNotReady'),
    CREDENTIAL_NOT_AVAILABLE: t('runtimeIssueCredentialMissing'),
    MODEL_NOT_ALLOWED: t('runtimeIssueModelNotAllowed'),
    INVALID_INTELLIGENCE: t('runtimeIssueInvalidIntelligence'),
    PROVIDER_ID_MISMATCH: t('runtimeIssueProviderMismatch'),
    AGENT_DEFAULT_AMBIGUOUS: t('runtimeIssueAgentDefaultAmbiguous'),
  } satisfies Record<typeof issue.code, string>)[issue.code] : null;
  const visibleError = currentFeedback.error || runtimeError || (!validSelection ? issueMessage : null);

  const thinkingLabel = (level: PiThinkingLevel) => {
    const labels: Record<PiThinkingLevel, string> = {
      off: t('runtimeIntelligenceOff'),
      minimal: t('runtimeIntelligenceMinimal'),
      low: t('runtimeIntelligenceLow'),
      medium: t('runtimeIntelligenceMedium'),
      high: t('runtimeIntelligenceHigh'),
      xhigh: t('runtimeIntelligenceExtraHigh'),
    };
    return labels[level];
  };

  const sourceLabel = (source: AiRuntimeSelectionSource | null) => {
    if (!source) return t('runtimeSourceUnresolved');
    const labels: Record<AiRuntimeSelectionSource, string> = {
      session: t('runtimeSourceSession'),
      user_preference: t('runtimeSourceUserPreference'),
      agent_default: t('runtimeSourceAgentDefault'),
      workspace_default: t('runtimeSourceWorkspaceDefault'),
      app_default: t('runtimeSourceAppDefault'),
    };
    return labels[source];
  };

  const statusLabel = (provider: AiEffectiveCatalogProvider) => {
    if (!provider.credentialAvailable) return t('runtimeCredentialMissing');
    const labels: Record<AiEffectiveCatalogProvider['status'], string> = {
      ready: t('runtimeProviderReady'),
      degraded: t('runtimeProviderDegraded'),
      unverified: t('runtimeProviderUnverified'),
      disabled: t('runtimeProviderDisabled'),
    };
    return labels[provider.status];
  };

  const credentialScopeLabel = (provider: AiEffectiveCatalogProvider) => {
    const labels: Record<AiEffectiveCatalogProvider['credentialScope'], string> = {
      managed: t('runtimeCredentialScopeManaged'),
      system: t('runtimeCredentialScopeSystem'),
      organization: t('runtimeCredentialScopeOrganization'),
      user: t('runtimeCredentialScopeUser'),
    };
    return labels[provider.credentialScope];
  };

  useEffect(() => {
    if (!currentFeedback.saved) return;
    const timer = window.setTimeout(() => {
      setFeedback((current) => (
        current.contextKey === contextKey ? { ...current, saved: false } : current
      ));
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [contextKey, currentFeedback.saved]);

  async function applySelection(next: AiRuntimeSelection) {
    if (currentFeedback.pending) return;
    if (
      selection
      && next.providerInstallationId === selection.providerInstallationId
      && next.providerId === selection.providerId
      && next.modelId === selection.modelId
      && next.thinkingLevel === selection.thinkingLevel
    ) {
      return;
    }

    if (!sessionId) {
      onSelectionChange(next);
      setFeedback({ contextKey, pending: false, saved: true, error: null });
      return;
    }
    if (!resolution) return;
    const targetContextKey = contextKey;

    setFeedback({ contextKey, pending: true, saved: false, error: null });
    try {
      const payload = await patchChatSessions({
        agentId,
        sessionId,
        runtimeSelection: next,
        expectedCatalogRevision: resolution.catalogRevision,
        expectedPolicyRevision: resolution.policyRevision,
      });
      if (payload?.success !== true) {
        throw new Error(payload?.error || t('runtimeSwitchFailed'));
      }

      // The server already updated the session captured above. If the user
      // switched context while the request was in flight, do not overwrite or
      // invalidate the newly active chat with the old session's result.
      if (latestContextKeyRef.current !== targetContextKey) {
        setFeedback({ contextKey: targetContextKey, pending: false, saved: true, error: null });
        return;
      }

      const nextResolution = payload.resolution;
      const serverSelection = nextResolution?.effectiveSelection?.selection ?? next;
      onSelectionChange(serverSelection);
      if (nextResolution) onResolutionChange?.(nextResolution);
      await onRuntimeStatusRefresh?.();
      if (!nextResolution) await onResolutionRefresh?.();
      setFeedback({ contextKey, pending: false, saved: true, error: null });
    } catch (error) {
      setFeedback({
        contextKey,
        pending: false,
        saved: false,
        error: error instanceof Error ? error.message : t('runtimeSwitchFailed'),
      });
      await onResolutionRefresh?.();
    }
  }

  function selectProvider(provider: AiEffectiveCatalogProvider) {
    if (!provider.selectable) return;
    const currentModel = provider.models.find((model) => model.id === selection?.modelId);
    const model = currentModel
      ?? provider.models.find((candidate) => candidate.isProviderDefault)
      ?? provider.models[0];
    if (!model) return;
    void applySelection({
      providerInstallationId: provider.installationId,
      providerId: provider.providerId,
      modelId: model.id,
      thinkingLevel: preferredThinkingLevel(model, selection?.thinkingLevel),
    });
  }

  function selectModel(model: AiCatalogModel) {
    if (!selectedProvider?.selectable) return;
    void applySelection({
      providerInstallationId: selectedProvider.installationId,
      providerId: selectedProvider.providerId,
      modelId: model.id,
      thinkingLevel: preferredThinkingLevel(model, selection?.thinkingLevel),
    });
  }

  function selectThinkingLevel(level: PiThinkingLevel) {
    if (!selection || !selectedModel?.thinkingLevels.includes(level)) return;
    void applySelection({ ...selection, thinkingLevel: level });
  }

  const modelName = selectedModel?.name || selection?.modelId || t('setModel');
  const providerName = selectedProvider?.name || selection?.providerId || t('runtimeProviderLabel');
  const intelligenceName = thinkingLabel(selection?.thinkingLevel ?? 'off');
  const currentSourceLabel = sourceLabel(selectionSource);
  const title = visibleError || t('runtimeSelectionTitle', {
    provider: providerName,
    model: modelName,
    intelligence: intelligenceName,
    source: currentSourceLabel,
  });

  return (
    <div className="flex min-w-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!canChange}>
          <button
            type="button"
            data-testid="chat-model-selector"
            aria-label={t('runtimeSelectorAria')}
            title={title}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/60 text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
              compact ? 'max-w-[210px] px-2 py-1 text-[11px]' : 'max-w-[330px] px-2.5 py-1 text-xs',
              visibleError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border/60',
            )}
          >
            {currentFeedback.pending ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : currentFeedback.saved ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : validSelection ? (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            )}
            {!compact ? (
              <span className="min-w-0 truncate text-muted-foreground">{providerName}</span>
            ) : null}
            {!compact ? <span className="text-border">/</span> : null}
            <span className="min-w-0 truncate font-mono font-medium">{getModelShortLabel(modelName)}</span>
            {thinkingLevels.length > 0 ? (
              <span className="shrink-0 text-muted-foreground">· {intelligenceName}</span>
            ) : null}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          side="top"
          collisionPadding={12}
          className="max-h-[min(34rem,80vh)] w-[min(92vw,360px)] max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg bg-popover/95 p-1.5 shadow-xl backdrop-blur"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t('runtimeSelectorTitle')}
              </span>
              <span className={cn(
                'rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
                validSelection
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
              )}>
                {currentSourceLabel}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-foreground">{providerName} · {modelName}</p>
          </div>

          <DropdownMenuSeparator className="mx-2" />
          <DropdownMenuLabel className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t('runtimeProviderLabel')}
          </DropdownMenuLabel>
          {providers.length > 0 ? providers.map((provider) => (
            <DropdownMenuItem
              key={provider.installationId}
              disabled={!provider.selectable}
              onSelect={() => selectProvider(provider)}
              className="flex min-h-10 items-center rounded-md px-2.5 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{provider.name}</span>
                <span className={cn(
                  'block truncate text-[10px] leading-4',
                  provider.selectable ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300',
                )}>
                  {provider.selectable
                    ? credentialScopeLabel(provider)
                    : `${credentialScopeLabel(provider)} · ${statusLabel(provider)}`}
                </span>
              </span>
              {selection?.providerInstallationId === provider.installationId ? (
                <Check className="ml-2 h-4 w-4 shrink-0 text-emerald-500" />
              ) : null}
            </DropdownMenuItem>
          )) : (
            <DropdownMenuItem disabled className="min-h-8 rounded-md px-2.5 py-1.5 text-sm">
              {t('runtimeNoProviders')}
            </DropdownMenuItem>
          )}

          {selectedProvider ? (
            <>
              <DropdownMenuSeparator className="mx-2 my-1.5" />
              <DropdownMenuLabel className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t('runtimeModelLabel')}
              </DropdownMenuLabel>
              {models.map((model) => (
                <DropdownMenuItem
                  key={model.id}
                  onSelect={() => selectModel(model)}
                  className="flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{model.name}</span>
                    {model.id !== model.name ? (
                      <span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground">{model.id}</span>
                    ) : null}
                  </span>
                  {selection?.modelId === model.id ? (
                    <Check className="ml-2 h-4 w-4 shrink-0 text-emerald-500" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}

          {selectedModel && thinkingLevels.length > 0 ? (
            <>
              <DropdownMenuSeparator className="mx-2 my-1.5" />
              <DropdownMenuLabel className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t('runtimeIntelligenceLabel')}
              </DropdownMenuLabel>
              {THINKING_LEVELS.filter((level) => thinkingLevels.includes(level)).map((level) => (
                <DropdownMenuItem
                  key={level}
                  onSelect={() => selectThinkingLevel(level)}
                  className="flex min-h-8 items-center rounded-md px-2.5 py-1.5 text-sm"
                >
                  <span>{thinkingLabel(level)}</span>
                  {selection?.thinkingLevel === level ? (
                    <Check className="ml-auto h-4 w-4 text-emerald-500" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}

          <DropdownMenuSeparator className="mx-2 my-1.5" />
          <div className="px-2.5 py-1 text-[10px] leading-4 text-muted-foreground">
            {sessionId ? t('runtimeAppliesToSession') : t('runtimeAppliesToNewSession')}
          </div>
          {visibleError ? (
            <div className="mx-1.5 mt-1 rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-[11px] leading-4 text-destructive" role="alert">
              {visibleError}
            </div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
