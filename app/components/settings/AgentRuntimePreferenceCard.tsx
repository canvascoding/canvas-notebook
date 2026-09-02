'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BrainCircuit, Check, Loader2, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type {
  AiCatalogModel,
  AiEffectiveCatalogProvider,
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { enableInteractiveUserCredentialGrant } from '@/app/lib/agent-runtime-policy/user-credential-grants-client';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';

import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';
import { PiOAuthButton } from './PiOAuthButton';

type RuntimeResponse = {
  success?: boolean;
  data?: AiEffectiveRuntimeResolution;
  error?: string;
};

type AgentRuntimePreferenceCardProps = {
  agentId: string;
  agentName: string;
  canManageRuntimeCatalog: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

function preferredThinkingLevel(
  model: AiCatalogModel,
  current?: AiRuntimeSelection['thinkingLevel'],
): AiRuntimeSelection['thinkingLevel'] {
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
  return resolution.providers.find(
    (provider) => provider.installationId === selection.providerInstallationId,
  ) ?? null;
}

function modelForSelection(
  provider: AiEffectiveCatalogProvider | null,
  selection: AiRuntimeSelection | null,
): AiCatalogModel | null {
  if (!provider || !selection) return null;
  return provider.models.find((model) => model.id === selection.modelId) ?? null;
}

async function readRuntimeResponse(response: Response, fallback: string): Promise<AiEffectiveRuntimeResolution> {
  const payload = await response.json().catch(() => null) as RuntimeResponse | null;
  if (!response.ok || payload?.success !== true || !payload.data) {
    throw new Error(payload?.error || fallback);
  }
  return payload.data;
}

export function AgentRuntimePreferenceCard({
  agentId,
  agentName,
  canManageRuntimeCatalog,
  isOpen,
  onOpenChange,
}: AgentRuntimePreferenceCardProps) {
  const t = useTranslations('settings.agentPanel.runtimePreference');
  const providerT = useTranslations('settings.provider');
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const workspaceInitialized = useWorkspaceStore((state) => state.initialized);
  const workspaceLoading = useWorkspaceStore((state) => state.isLoading);
  const workspaceError = useWorkspaceStore((state) => state.error);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const [resolution, setResolution] = useState<AiEffectiveRuntimeResolution | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const savedTimerRef = useRef<number | null>(null);

  const workspaceId = activeWorkspace?.id ?? null;
  const selection = resolution?.preference?.selection
    ?? resolution?.effectiveSelection?.selection
    ?? null;
  const selectedProvider = useMemo(
    () => providerForSelection(resolution, selection),
    [resolution, selection],
  );
  const selectedModel = useMemo(
    () => modelForSelection(selectedProvider, selection),
    [selectedProvider, selection],
  );
  const providers = useMemo(
    () => (resolution?.providers ?? []).filter(
      (provider) => provider.models.some((model) => model.enabled),
    ),
    [resolution],
  );
  const models = selectedProvider?.models.filter((model) => model.enabled) ?? [];
  const teamUserCredentialProviders = useMemo(
    () => activeWorkspace?.type !== 'personal'
      ? providers.filter((provider) => provider.credentialScope === 'user' && provider.authMethod === 'oauth')
      : [],
    [activeWorkspace?.type, providers],
  );
  const controlsDisabled = loading || saving || !resolution;

  const showSaved = useCallback(() => {
    setSaved(true);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      setSaved(false);
    }, 1600);
  }, []);

  useEffect(() => () => {
    requestRef.current += 1;
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
  }, []);

  useEffect(() => {
    if (workspaceInitialized || workspaceLoading) return;
    void hydrateWorkspaces();
  }, [hydrateWorkspaces, workspaceInitialized, workspaceLoading]);

  const loadResolution = useCallback(async () => {
    if (!workspaceId || !agentId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const query = new URLSearchParams({ workspaceId, agentId });
      const response = await fetch(`/api/agent-runtime/preferences?${query.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const nextResolution = await readRuntimeResponse(response, t('errors.load'));
      if (requestId === requestRef.current) setResolution(nextResolution);
    } catch (loadError) {
      if (requestId === requestRef.current) {
        setResolution(null);
        setError(loadError instanceof Error ? loadError.message : t('errors.load'));
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [agentId, t, workspaceId]);

  useEffect(() => {
    if (!workspaceInitialized || !workspaceId || !agentId) return;
    const timer = window.setTimeout(() => void loadResolution(), 0);
    return () => window.clearTimeout(timer);
  }, [agentId, loadResolution, workspaceId, workspaceInitialized]);

  const saveSelection = async (nextSelection: AiRuntimeSelection) => {
    if (!workspaceId || !resolution || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/agent-runtime/preferences', {
        method: 'PATCH',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          agentId,
          expectedRevision: resolution.preference?.revision ?? 0,
          expectedCatalogRevision: resolution.catalogRevision,
          expectedPolicyRevision: resolution.policyRevision,
          selection: nextSelection,
        }),
      });
      const nextResolution = await readRuntimeResponse(response, t('errors.save'));
      setResolution(nextResolution);
      showSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const resetPreference = async () => {
    if (!workspaceId || !resolution?.preference || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const query = new URLSearchParams({
        workspaceId,
        agentId,
        expectedRevision: String(resolution.preference.revision),
      });
      const response = await fetch(`/api/agent-runtime/preferences?${query.toString()}`, {
        method: 'DELETE',
        credentials: 'include',
        cache: 'no-store',
      });
      const nextResolution = await readRuntimeResponse(response, t('errors.reset'));
      setResolution(nextResolution);
      showSaved();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : t('errors.reset'));
    } finally {
      setSaving(false);
    }
  };

  const enablePersonalCredential = async (provider: AiEffectiveCatalogProvider) => {
    if (!workspaceId || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await enableInteractiveUserCredentialGrant({
        workspaceId,
        agentId,
        providerInstallationId: provider.installationId,
        fallbackError: t('errors.save'),
      });
      await loadResolution();
      showSaved();
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : t('errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const handleProviderChange = (installationId: string) => {
    const provider = providers.find((candidate) => candidate.installationId === installationId);
    const model = provider?.models.find((candidate) => candidate.enabled && candidate.isProviderDefault)
      ?? provider?.models.find((candidate) => candidate.enabled);
    if (!provider?.selectable || !model) return;
    void saveSelection({
      providerInstallationId: provider.installationId,
      providerId: provider.providerId,
      modelId: model.id,
      thinkingLevel: preferredThinkingLevel(model, selection?.thinkingLevel),
    });
  };

  const handleModelChange = (modelId: string) => {
    const model = models.find((candidate) => candidate.id === modelId);
    if (!selectedProvider?.selectable || !model) return;
    void saveSelection({
      providerInstallationId: selectedProvider.installationId,
      providerId: selectedProvider.providerId,
      modelId: model.id,
      thinkingLevel: preferredThinkingLevel(model, selection?.thinkingLevel),
    });
  };

  const summaryItems = selection
    ? [
        selectedProvider?.name || selection.providerId,
        selectedModel?.name || selection.modelId,
        providerT(`thinkingLevels.${selection.thinkingLevel}`),
      ]
    : [t('unavailable')];

  return (
    <AgentSettingsAccordionCard
      id="onboarding-settings-agentSettings"
      title={t('title')}
      description={t('description', { agentName })}
      icon={BrainCircuit}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
      contentClassName="space-y-4"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/25 px-3 py-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {activeWorkspace ? t('workspaceContext', { workspaceName: activeWorkspace.name }) : t('workspaceUnavailable')}
        </p>
        <div className="flex shrink-0 items-center gap-1.5 text-xs" aria-live="polite">
          {saving || loading ? (
            <><Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> {t(saving ? 'saving' : 'loading')}</>
          ) : saved ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
              <Check className="size-3.5" aria-hidden="true" /> {t('saved')}
            </span>
          ) : resolution?.preference ? (
            <span className="text-muted-foreground">{t('personal')}</span>
          ) : (
            <span className="text-muted-foreground">{t('inherited')}</span>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(9rem,0.65fr)]">
        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('provider')}</span>
          <select
            data-testid="agent-runtime-provider"
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            value={selection?.providerInstallationId ?? ''}
            onChange={(event) => handleProviderChange(event.target.value)}
            disabled={controlsDisabled || providers.length === 0}
          >
            <option value="" disabled>{t('selectProvider')}</option>
            {providers.map((provider) => (
              <option key={provider.installationId} value={provider.installationId} disabled={!provider.selectable}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('model')}</span>
          <select
            data-testid="agent-runtime-model"
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            value={selection?.modelId ?? ''}
            onChange={(event) => handleModelChange(event.target.value)}
            disabled={controlsDisabled || !selectedProvider?.selectable}
          >
            <option value="" disabled>{t('selectModel')}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name || model.id}</option>
            ))}
          </select>
        </label>

        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('intelligence')}</span>
          <select
            data-testid="agent-runtime-thinking"
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            value={selection?.thinkingLevel ?? 'off'}
            onChange={(event) => {
              if (!selection || !selectedModel) return;
              const thinkingLevel = event.target.value as AiRuntimeSelection['thinkingLevel'];
              if (selectedModel.thinkingLevels.includes(thinkingLevel)) {
                void saveSelection({ ...selection, thinkingLevel });
              }
            }}
            disabled={controlsDisabled || !selectedModel}
          >
            {(selectedModel?.thinkingLevels ?? ['off']).map((level) => (
              <option key={level} value={level}>{providerT(`thinkingLevels.${level}`)}</option>
            ))}
          </select>
        </label>
      </div>

      {teamUserCredentialProviders.length > 0 && (
        <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-sm">
          <p className="font-medium">{t('personalCredentialsTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('personalCredentialsDescription')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {teamUserCredentialProviders.map((provider) => (
              <div key={provider.installationId} className="flex flex-wrap items-center gap-2">
                <PiOAuthButton activeProviderId={provider.providerId} onStatusChange={() => void loadResolution()} />
                {provider.userCredentialEligibility?.consentGranted ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <Check className="size-3.5" aria-hidden="true" />
                    {t('personalCredentialsEnabled', { provider: provider.name })}
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void enablePersonalCredential(provider)}
                  >
                    {t('personalCredentialsEnable', { provider: provider.name })}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(error || workspaceError || (!loading && resolution && !resolution.valid)) && (
        <div className="flex min-w-0 items-start justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100" role="alert">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="break-words">
              {error || workspaceError || resolution?.issues[0]?.message || t('unavailable')}
            </span>
          </span>
          {canManageRuntimeCatalog && (
            <Button type="button" variant="outline" size="sm" className="shrink-0" asChild>
              <a href="?tab=ai-providers">{t('openProviders')}</a>
            </Button>
          )}
        </div>
      )}

      {resolution?.preference && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void resetPreference()}
          disabled={saving}
          className="h-8 px-2 text-xs text-muted-foreground"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t('useDefault')}
        </Button>
      )}
    </AgentSettingsAccordionCard>
  );
}
