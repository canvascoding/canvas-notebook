'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type {
  AiCatalogModel,
  AiEffectiveCatalogProvider,
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
} from '@/app/lib/agent-runtime-policy/types';
import { enableInteractiveUserCredentialGrant } from '@/app/lib/agent-runtime-policy/user-credential-grants-client';
import { patchChatSessions } from '@/app/lib/chat/session-api';
import { PiOAuthButton } from '@/app/components/settings/PiOAuthButton';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { useIsMobile } from '@/hooks/use-mobile';
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

type RuntimeSelectorView = 'overview' | 'models' | 'intelligence';

type PersonalProviderActivation = {
  providerInstallationId: string;
  connected: boolean;
  consentGranted: boolean;
};

const THINKING_LEVELS: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

function supportsPersonalProviderActivation(provider: AiEffectiveCatalogProvider): boolean {
  return provider.credentialScope === 'user'
    && provider.authMethod === 'oauth'
    && Boolean(provider.userCredentialEligibility);
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
  const isMobile = useIsMobile();
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
  const [providerSheetOpen, setProviderSheetOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectorView, setSelectorView] = useState<RuntimeSelectorView>('overview');
  const [personalActivation, setPersonalActivation] = useState<PersonalProviderActivation | null>(null);
  const [personalGrantPending, setPersonalGrantPending] = useState(false);
  const [personalGrantError, setPersonalGrantError] = useState<string | null>(null);
  const personalActivationRef = useRef<PersonalProviderActivation | null>(null);
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
  const personalProvider = personalActivation
    ? providers.find((provider) => provider.installationId === personalActivation.providerInstallationId) ?? null
    : null;
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
      max: 'Maximum',
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
    if (provider.userCredentialEligibility?.state === 'consent_required') {
      return t('runtimePersonalConsentRequired');
    }
    if (provider.userCredentialEligibility?.state === 'not_connected') {
      return t('runtimePersonalAccountNotConnected');
    }
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

  function applyProviderSelection(provider: AiEffectiveCatalogProvider) {
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

  function selectProvider(provider: AiEffectiveCatalogProvider) {
    if (!provider.selectable) {
      if (supportsPersonalProviderActivation(provider)) {
        const nextActivation = {
          providerInstallationId: provider.installationId,
          connected: provider.userCredentialEligibility?.connected ?? false,
          consentGranted: provider.userCredentialEligibility?.consentGranted ?? false,
        };
        personalActivationRef.current = nextActivation;
        setPersonalActivation(nextActivation);
        setPersonalGrantError(null);
      }
      return;
    }
    applyProviderSelection(provider);
  }

  async function enablePersonalProvider(provider: AiEffectiveCatalogProvider) {
    const workspaceId = resolution?.context.workspaceId;
    if (!workspaceId || personalGrantPending) return;
    setPersonalGrantPending(true);
    setPersonalGrantError(null);
    try {
      await enableInteractiveUserCredentialGrant({
        workspaceId,
        agentId,
        providerInstallationId: provider.installationId,
        fallbackError: t('runtimePersonalGrantFailed'),
      });
      const current = personalActivationRef.current;
      const nextActivation = {
        providerInstallationId: provider.installationId,
        connected: current?.providerInstallationId === provider.installationId
          ? current.connected
          : provider.userCredentialEligibility?.connected ?? false,
        consentGranted: true,
      };
      personalActivationRef.current = nextActivation;
      setPersonalActivation(nextActivation);
      await onResolutionRefresh?.();
      if (nextActivation.connected) {
        setPersonalActivation(null);
        personalActivationRef.current = null;
        applyProviderSelection(provider);
      }
    } catch (error) {
      setPersonalGrantError(error instanceof Error ? error.message : t('runtimePersonalGrantFailed'));
    } finally {
      setPersonalGrantPending(false);
    }
  }

  async function handlePersonalProviderStatusChange(
    provider: AiEffectiveCatalogProvider,
    status: { provider: string; connected: boolean },
  ) {
    if (status.provider !== provider.providerId) return;
    const current = personalActivationRef.current;
    const nextActivation = {
      providerInstallationId: provider.installationId,
      connected: status.connected,
      consentGranted: current?.providerInstallationId === provider.installationId
        ? current.consentGranted
        : provider.userCredentialEligibility?.consentGranted ?? false,
    };
    personalActivationRef.current = nextActivation;
    setPersonalActivation(nextActivation);
    await onResolutionRefresh?.();
    if (status.connected && nextActivation.consentGranted) {
      setPersonalActivation(null);
      personalActivationRef.current = null;
      applyProviderSelection(provider);
    }
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

  const openSelectorView = (view: RuntimeSelectorView) => {
    setSelectorView(view);
  };

  const closeModelSheet = () => {
    setModelSheetOpen(false);
    setSelectorView('overview');
  };

  const selectorViewTitle = selectorView === 'models'
    ? t('runtimeModelLabel')
    : selectorView === 'intelligence'
      ? t('runtimeIntelligenceLabel')
      : t('runtimeSelectorTitle');
  const selectorViewDescription = selectorView === 'models'
    ? t('runtimeModelDescription', { provider: providerName })
    : selectorView === 'intelligence'
      ? t('runtimeIntelligenceDescription', { model: modelName })
      : `${providerName} · ${modelName}`;

  const providerTrigger = (
    <button
      type="button"
      data-testid="chat-provider-selector"
      aria-label={t('runtimeProviderSelectorAria')}
      title={providerName}
      disabled={!canChange}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/60 px-2 py-1 text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
        compact ? 'max-w-[7.5rem] text-[11px]' : 'max-w-[12rem] text-xs',
        visibleError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border/60',
      )}
    >
      <span className="min-w-0 truncate">{providerName}</span>
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );

  const modelTrigger = (
    <button
      type="button"
      data-testid="chat-model-selector"
      aria-label={t('runtimeModelSelectorAria')}
      title={title}
      disabled={!canChange}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/60 px-2 py-1 text-foreground shadow-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
        compact ? 'max-w-[10.5rem] text-[11px]' : 'max-w-[17rem] text-xs',
        visibleError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border/60',
      )}
    >
      {currentFeedback.pending ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : currentFeedback.saved ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
      ) : validSelection ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate font-medium">
        {compact ? getModelShortLabel(modelName) : modelName}
      </span>
      {thinkingLevels.length > 0 ? (
        <span className="shrink-0 text-muted-foreground">· {intelligenceName}</span>
      ) : null}
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );

  const renderProviderOptions = (mobile: boolean) => providers.length > 0 ? providers.map((provider) => {
    const canActivateProvider = provider.selectable || supportsPersonalProviderActivation(provider);
    const optionContent = (
      <>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{provider.name}</span>
          <span className={cn(
            'block truncate text-[11px] leading-4',
            provider.selectable ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300',
          )}>
            {provider.selectable
              ? credentialScopeLabel(provider)
              : `${credentialScopeLabel(provider)} · ${statusLabel(provider)}`}
          </span>
        </span>
        {selection?.providerInstallationId === provider.installationId ? (
          <Check className="ml-2 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
        ) : null}
      </>
    );

    if (mobile) {
      return (
        <button
          key={provider.installationId}
          type="button"
          disabled={!canActivateProvider || currentFeedback.pending}
          onClick={() => {
            selectProvider(provider);
            setProviderSheetOpen(false);
          }}
          className="flex min-h-14 w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {optionContent}
        </button>
      );
    }

    return (
      <DropdownMenuItem
        key={provider.installationId}
        disabled={!canActivateProvider}
        onSelect={() => selectProvider(provider)}
        className="flex min-h-11 items-center rounded-md px-2.5 py-1.5 text-sm"
      >
        {optionContent}
      </DropdownMenuItem>
    );
  }) : (
    <div className="px-3 py-4 text-sm text-muted-foreground">{t('runtimeNoProviders')}</div>
  );

  const renderModelOptions = (mobile: boolean) => models.length > 0 ? models.map((model) => {
    const optionContent = (
      <>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{model.name}</span>
          {model.id !== model.name ? (
            <span className="block truncate text-[11px] leading-4 text-muted-foreground">{model.id}</span>
          ) : null}
        </span>
        {selection?.modelId === model.id ? (
          <Check className="ml-2 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
        ) : null}
      </>
    );

    if (mobile) {
      return (
        <button
          key={model.id}
          type="button"
          disabled={currentFeedback.pending}
          onClick={() => {
            selectModel(model);
            closeModelSheet();
          }}
          className="flex min-h-14 w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {optionContent}
        </button>
      );
    }

    return (
      <DropdownMenuItem
        key={model.id}
        onSelect={() => selectModel(model)}
        className="flex min-h-11 items-center rounded-md px-2.5 py-1.5 text-sm"
      >
        {optionContent}
      </DropdownMenuItem>
    );
  }) : (
    <div className="px-3 py-4 text-sm text-muted-foreground">{t('noModelsAvailable')}</div>
  );

  const renderIntelligenceOptions = (mobile: boolean) => (
    THINKING_LEVELS.filter((level) => thinkingLevels.includes(level)).map((level) => {
      const optionContent = (
        <>
          <span>{thinkingLabel(level)}</span>
          {selection?.thinkingLevel === level ? (
            <Check className="ml-auto h-4 w-4 text-emerald-500" aria-hidden="true" />
          ) : null}
        </>
      );

      if (mobile) {
        return (
          <button
            key={level}
            type="button"
            disabled={currentFeedback.pending}
            onClick={() => {
              selectThinkingLevel(level);
              closeModelSheet();
            }}
            className="flex min-h-12 w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {optionContent}
          </button>
        );
      }

      return (
        <DropdownMenuItem
          key={level}
          onSelect={() => selectThinkingLevel(level)}
          className="flex min-h-10 items-center rounded-md px-2.5 py-1.5 text-sm"
        >
          {optionContent}
        </DropdownMenuItem>
      );
    })
  );

  const selectorOverview = (mobile: boolean) => (
    <div className={cn('p-1.5', mobile && 'px-2 pb-3')}>
      <button
        type="button"
        data-testid="chat-model-selector-model-row"
        onClick={() => openSelectorView('models')}
        className={cn(
          'flex w-full items-center gap-3 rounded-md px-3 text-left transition-colors hover:bg-accent',
          mobile ? 'min-h-14' : 'min-h-11',
        )}
      >
        <span className="min-w-0 flex-1 text-sm font-medium">{t('runtimeModelLabel')}</span>
        <span className="max-w-[60%] truncate text-sm text-muted-foreground">{modelName}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <div className="mx-3 border-t border-border" />
      <button
        type="button"
        data-testid="chat-model-selector-intelligence-row"
        onClick={() => openSelectorView('intelligence')}
        disabled={!selectedModel || thinkingLevels.length === 0}
        className={cn(
          'flex w-full items-center gap-3 rounded-md px-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
          mobile ? 'min-h-14' : 'min-h-11',
        )}
      >
        <span className="min-w-0 flex-1 text-sm font-medium">{t('runtimeIntelligenceLabel')}</span>
        <span className="max-w-[60%] truncate text-sm text-muted-foreground">{intelligenceName}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  );

  const selectorOptions = (mobile: boolean) => selectorView === 'models'
    ? renderModelOptions(mobile)
    : selectorView === 'intelligence'
      ? renderIntelligenceOptions(mobile)
      : selectorOverview(mobile);

  const selectorHeader = (mobile: boolean) => (
    <div className={cn(
      'flex items-start gap-2 border-b border-border px-3 py-3',
      mobile && 'pr-12',
    )}>
      {selectorView !== 'overview' ? (
        <button
          type="button"
          onClick={() => openSelectorView('overview')}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t('runtimeSelectorBack')}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{selectorViewTitle}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{selectorViewDescription}</p>
      </div>
    </div>
  );

  const selectorError = visibleError ? (
    <div className="mx-2 mb-2 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs leading-4 text-destructive" role="alert">
      {visibleError}
    </div>
  ) : null;

  return (
    <>
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-1.5">
        {isMobile ? (
          <Sheet open={providerSheetOpen} onOpenChange={setProviderSheetOpen}>
            <SheetTrigger asChild>{providerTrigger}</SheetTrigger>
            <SheetContent side="bottom" className="max-h-[78dvh] gap-0 overflow-hidden rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]">
              <SheetHeader className="border-b border-border px-4 py-3 pr-12 text-left">
                <SheetTitle>{t('runtimeProviderLabel')}</SheetTitle>
                <SheetDescription>{t('runtimeProviderDescription')}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {renderProviderOptions(true)}
                {selectorError}
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>{providerTrigger}</DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="top"
              collisionPadding={12}
              className="max-h-[min(28rem,76vh)] w-[min(90vw,300px)] overflow-y-auto rounded-lg bg-popover/95 p-1.5 shadow-xl backdrop-blur"
            >
              <DropdownMenuLabel className="px-2.5 py-1.5 text-xs font-semibold">
                {t('runtimeProviderLabel')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="mx-2" />
              {renderProviderOptions(false)}
              {selectorError}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {isMobile ? (
          <Sheet
            open={modelSheetOpen}
            onOpenChange={(open) => {
              setModelSheetOpen(open);
              if (!open) setSelectorView('overview');
            }}
          >
            <SheetTrigger asChild>{modelTrigger}</SheetTrigger>
            <SheetContent side="bottom" className="max-h-[82dvh] gap-0 overflow-hidden rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]">
              <SheetHeader className="sr-only">
                <SheetTitle>{selectorViewTitle}</SheetTitle>
                <SheetDescription>{selectorViewDescription}</SheetDescription>
              </SheetHeader>
              {selectorHeader(true)}
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {selectorOptions(true)}
                {selectorError}
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <DropdownMenu
            open={modelMenuOpen}
            onOpenChange={(open) => {
              setModelMenuOpen(open);
              if (!open) setSelectorView('overview');
            }}
          >
            <DropdownMenuTrigger asChild>{modelTrigger}</DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="top"
              collisionPadding={12}
              className="w-[min(92vw,340px)] max-w-[calc(100vw-24px)] overflow-hidden rounded-lg bg-popover/95 p-0 shadow-xl backdrop-blur"
            >
              {selectorHeader(false)}
              <div className="max-h-[min(28rem,76vh)] overflow-y-auto p-1.5">
                {selectorOptions(false)}
                {selectorError}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <Dialog
        open={Boolean(personalProvider)}
        onOpenChange={(open) => {
          if (open) return;
          setPersonalActivation(null);
          personalActivationRef.current = null;
          setPersonalGrantError(null);
        }}
      >
        <DialogContent className="max-h-[min(46rem,90dvh)] overflow-y-auto sm:max-w-xl" data-testid="chat-personal-provider-dialog">
          {personalProvider ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('runtimePersonalAccessTitle', { provider: personalProvider.name })}</DialogTitle>
                <DialogDescription>
                  {t('runtimePersonalAccessDescription', { provider: personalProvider.name })}
                </DialogDescription>
              </DialogHeader>

              <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-sm leading-5">
                <p className="font-medium">{t('runtimePersonalAccessScopeTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('runtimePersonalAccessScopeDescription')}
                </p>
              </div>

              <PiOAuthButton
                activeProviderId={personalProvider.providerId}
                onStatusChange={(status) => void handlePersonalProviderStatusChange(personalProvider, status)}
              />

              {personalActivation?.consentGranted ? (
                <div className="inline-flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                  {t('runtimePersonalGrantActive')}
                </div>
              ) : (
                <Button
                  type="button"
                  disabled={personalGrantPending}
                  onClick={() => void enablePersonalProvider(personalProvider)}
                  data-testid="chat-personal-provider-grant"
                >
                  {personalGrantPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {t('runtimePersonalGrantAction', { provider: personalProvider.name })}
                </Button>
              )}

              {personalGrantError ? (
                <div className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                  {personalGrantError}
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
