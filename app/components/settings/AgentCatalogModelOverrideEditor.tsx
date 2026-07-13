'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BrainCircuit, Loader2, RefreshCw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type {
  AiAppRuntimeCatalog,
  AiCatalogModel,
  AiProviderInstallation,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';
import { readAdminRuntimeCatalog } from './ai-runtime/catalog-client';

export type AgentCatalogModelSelection = AiRuntimeSelection;

type AgentCatalogModelOverrideEditorProps = {
  catalog: AiAppRuntimeCatalog | null;
  selection: AgentCatalogModelSelection | null;
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  onSelectionChange: (selection: AgentCatalogModelSelection | null) => void;
  onRetry: () => void;
};

function enabledModels(provider: AiProviderInstallation): AiCatalogModel[] {
  return provider.models.filter((model) => model.enabled);
}

function selectableProviders(catalog: AiAppRuntimeCatalog | null): AiProviderInstallation[] {
  return (catalog?.providers ?? []).filter(
    (provider) => provider.enabled && provider.status === 'ready' && enabledModels(provider).length > 0,
  );
}

function supportedThinking(model: AiCatalogModel, preferred?: AiRuntimeSelection['thinkingLevel']) {
  if (preferred && model.thinkingLevels.includes(preferred)) return preferred;
  if (model.thinkingLevels.includes('off')) return 'off' as const;
  return model.thinkingLevels[0];
}

export function initialAgentCatalogSelection(
  catalog: AiAppRuntimeCatalog,
  current?: AgentCatalogModelSelection | null,
): AgentCatalogModelSelection | null {
  if (current && isAgentCatalogSelectionValid(catalog, current)) return { ...current };
  if (catalog.defaultSelection && isAgentCatalogSelectionValid(catalog, catalog.defaultSelection)) {
    return { ...catalog.defaultSelection };
  }
  return null;
}

export function isAgentCatalogSelectionValid(
  catalog: AiAppRuntimeCatalog | null,
  selection: AgentCatalogModelSelection | null,
): boolean {
  if (!catalog || !selection) return false;
  const provider = catalog.providers.find(
    (candidate) => candidate.installationId === selection.providerInstallationId,
  );
  if (
    !provider
    || !provider.enabled
    || provider.status !== 'ready'
    || provider.providerId !== selection.providerId
  ) {
    return false;
  }
  const model = provider.models.find((candidate) => candidate.enabled && candidate.id === selection.modelId);
  return Boolean(model?.thinkingLevels.includes(selection.thinkingLevel));
}

export function AgentCatalogModelOverrideEditor({
  catalog,
  selection,
  loading,
  error,
  disabled = false,
  onSelectionChange,
  onRetry,
}: AgentCatalogModelOverrideEditorProps) {
  const t = useTranslations('settings.agentPanel.inheritance');
  const providerT = useTranslations('settings.provider');
  const providers = selectableProviders(catalog);
  const selectedProvider = selection
    ? catalog?.providers.find((provider) => provider.installationId === selection.providerInstallationId) ?? null
    : null;
  const models = selectedProvider ? enabledModels(selectedProvider) : [];
  const selectedModel = selection
    ? models.find((model) => model.id === selection.modelId) ?? null
    : null;
  const valid = isAgentCatalogSelectionValid(catalog, selection);

  if (!catalog && (loading || !error)) {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('catalogLoading')}
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <div className="flex items-start gap-2 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error || t('catalogLoadError')}</span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {t('reloadCatalog')}
        </Button>
      </div>
    );
  }

  const handleProviderChange = (installationId: string) => {
    const provider = providers.find((candidate) => candidate.installationId === installationId);
    const model = provider?.models.find((candidate) => candidate.enabled && candidate.isProviderDefault);
    const thinkingLevel = model ? supportedThinking(model) : undefined;
    onSelectionChange(provider && model && thinkingLevel
      ? {
          providerInstallationId: provider.installationId,
          providerId: provider.providerId,
          modelId: model.id,
          thinkingLevel,
        }
      : null);
  };

  const handleModelChange = (modelId: string) => {
    if (!selectedProvider) return;
    const model = models.find((candidate) => candidate.id === modelId);
    const thinkingLevel = model ? supportedThinking(model, selection?.thinkingLevel) : undefined;
    onSelectionChange(model && thinkingLevel
      ? {
          providerInstallationId: selectedProvider.installationId,
          providerId: selectedProvider.providerId,
          modelId: model.id,
          thinkingLevel,
        }
      : null);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-3">
        <p className="text-sm font-medium">{t('catalogReadyTitle')}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('catalogOnlyHint')}</p>
      </div>

      {providers.length === 0 && (
        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100" role="status">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('catalogEmpty')}</span>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <a href="?tab=ai-providers">{t('openProviders')}</a>
          </Button>
        </div>
      )}

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(10rem,0.7fr)]">
        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('providerInstallation')}</span>
          <select
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={selection?.providerInstallationId ?? ''}
            onChange={(event) => handleProviderChange(event.target.value)}
            disabled={disabled || providers.length === 0}
          >
            <option value="">{t('selectProviderInstallation')}</option>
            {providers.map((provider) => (
              <option key={provider.installationId} value={provider.installationId}>
                {provider.name} · {t(`credentialScope.${provider.credentialScope}`)}
              </option>
            ))}
            {selection && selectedProvider && !providers.some((provider) => provider.installationId === selectedProvider.installationId) && (
              <option value={selectedProvider.installationId} disabled>
                {selectedProvider.name} · {t('notReady')}
              </option>
            )}
          </select>
        </label>

        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('catalogModel')}</span>
          <select
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={selection?.modelId ?? ''}
            onChange={(event) => handleModelChange(event.target.value)}
            disabled={disabled || !selectedProvider}
          >
            <option value="">{providerT('selectModel')}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name || model.id}</option>
            ))}
          </select>
        </label>

        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('intelligence')}</span>
          <select
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={selection?.thinkingLevel ?? 'off'}
            onChange={(event) => {
              if (!selection || !selectedModel) return;
              const thinkingLevel = event.target.value as AiRuntimeSelection['thinkingLevel'];
              if (selectedModel.thinkingLevels.includes(thinkingLevel)) {
                onSelectionChange({ ...selection, thinkingLevel });
              }
            }}
            disabled={disabled || !selectedModel}
          >
            {(selectedModel?.thinkingLevels ?? ['off']).map((level) => (
              <option key={level} value={level}>{providerT(`thinkingLevels.${level}`)}</option>
            ))}
          </select>
        </label>
      </div>

      {selection && !valid && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <BrainCircuit className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('invalidCatalogSelection')}</span>
        </div>
      )}
      {error && catalog && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

type AgentDefaultProfile = {
  agentId: string;
  defaultProviderInstallationId: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinking: string | null;
};

type AgentCatalogModelOverrideCardProps = {
  agent: AgentDefaultProfile;
  canManage: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
};

function selectionFromAgent(agent: AgentDefaultProfile): AgentCatalogModelSelection | null {
  const thinkingLevel = agent.defaultThinking;
  if (
    !agent.defaultProviderInstallationId
    || !agent.defaultProvider
    || !agent.defaultModel
    || (thinkingLevel !== 'off'
      && thinkingLevel !== 'minimal'
      && thinkingLevel !== 'low'
      && thinkingLevel !== 'medium'
      && thinkingLevel !== 'high'
      && thinkingLevel !== 'xhigh')
  ) {
    return null;
  }
  return {
    providerInstallationId: agent.defaultProviderInstallationId,
    providerId: agent.defaultProvider,
    modelId: agent.defaultModel,
    thinkingLevel,
  };
}

async function patchAgentDefault(input: {
  agentId: string;
  catalogRevision?: number;
  selection: AgentCatalogModelSelection | null;
}) {
  const response = await fetch('/api/agents', {
    method: 'PATCH',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: input.agentId,
      defaultProviderInstallationId: input.selection?.providerInstallationId ?? null,
      defaultProvider: input.selection?.providerId ?? null,
      defaultModel: input.selection?.modelId ?? null,
      defaultThinking: input.selection?.thinkingLevel ?? null,
      ...(input.selection ? { expectedCatalogRevision: input.catalogRevision } : {}),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    code?: string;
    error?: string;
  };
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
}

export function AgentCatalogModelOverrideCard({
  agent,
  canManage,
  isOpen,
  onOpenChange,
  onSaved,
}: AgentCatalogModelOverrideCardProps) {
  const t = useTranslations('settings.agentPanel.inheritance');
  const storedSelection = selectionFromAgent(agent);
  const hasStoredOverride = Boolean(
    agent.defaultProviderInstallationId || agent.defaultProvider || agent.defaultModel || agent.defaultThinking,
  );
  const [overrideEnabled, setOverrideEnabled] = useState(Boolean(storedSelection || hasStoredOverride));
  const [catalog, setCatalog] = useState<AiAppRuntimeCatalog | null>(null);
  const [selection, setSelection] = useState<AgentCatalogModelSelection | null>(storedSelection);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    setError(null);
    try {
      const data = await readAdminRuntimeCatalog();
      setCatalog(data.catalog);
      setSelection((current) => initialAgentCatalogSelection(data.catalog, current));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('catalogLoadError'));
    } finally {
      setLoading(false);
    }
  }, [canManage, t]);

  useEffect(() => {
    if (!canManage || (!isOpen && !overrideEnabled) || catalog || loading) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadCatalog();
    });
    return () => {
      cancelled = true;
    };
  }, [canManage, catalog, isOpen, loadCatalog, loading, overrideEnabled]);

  const save = async () => {
    if (!canManage) return;
    if (overrideEnabled && !isAgentCatalogSelectionValid(catalog, selection)) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await patchAgentDefault({
        agentId: agent.agentId,
        catalogRevision: catalog?.revision,
        selection: overrideEnabled ? selection : null,
      });
      setSuccess(t('overrideSaved'));
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const summary = overrideEnabled
    ? t('usesDedicatedModel')
    : t('inheritsAppDefault');

  if (!canManage) {
    return (
      <AgentSettingsAccordionCard
        id="onboarding-settings-agentSettings"
        title={t('modelCardTitle')}
        description={t('modelCardReadOnlyDescription')}
        icon={BrainCircuit}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        summaryItems={[summary]}
      >
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{summary}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('modelDefaultAdminOnly')}
            </p>
          </div>
          {storedSelection && (
            <div className="flex flex-wrap gap-2" aria-label={t('storedModelDefault')}>
              <Badge variant="secondary">{t('dedicatedModel')}</Badge>
              <Badge variant="outline">{storedSelection.modelId}</Badge>
            </div>
          )}
        </div>
      </AgentSettingsAccordionCard>
    );
  }

  return (
    <AgentSettingsAccordionCard
      id="onboarding-settings-agentSettings"
      title={t('modelCardTitle')}
      description={t('modelCardDescription')}
      icon={BrainCircuit}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={[summary]}
    >
      <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 p-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{t('modelOverride')}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {overrideEnabled ? t('overrideEnabledDescription') : t('overrideDisabledDescription')}
          </p>
        </div>
        <Switch
          checked={overrideEnabled}
          onCheckedChange={(enabled) => {
            setOverrideEnabled(enabled);
            setSuccess(null);
            if (enabled && !catalog && !loading) void loadCatalog();
          }}
          disabled={saving}
          aria-label={t('modelOverride')}
          className="shrink-0"
        />
      </div>

      {(overrideEnabled || isOpen) && (
        <>
          {!overrideEnabled && (
            <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
              {t('inheritedDefaultPreview')}
            </p>
          )}
          <AgentCatalogModelOverrideEditor
            catalog={catalog}
            selection={selection}
            loading={loading}
            error={error}
            disabled={saving || !overrideEnabled}
            onSelectionChange={(nextSelection) => {
              setSelection(nextSelection);
              setSuccess(null);
            }}
            onRetry={() => void loadCatalog()}
          />
        </>
      )}

      {!overrideEnabled && error && (
        <p className="text-sm text-destructive" role="alert">{error}</p>
      )}
      {success && <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status">{success}</p>}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          onClick={() => void save()}
          disabled={saving || (overrideEnabled && !isAgentCatalogSelectionValid(catalog, selection))}
        >
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
          {saving ? t('savingOverride') : t('saveOverride')}
        </Button>
        {overrideEnabled && (
          <Button type="button" variant="outline" onClick={() => void loadCatalog()} disabled={loading || saving}>
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            {t('reloadCatalog')}
          </Button>
        )}
      </div>
    </AgentSettingsAccordionCard>
  );
}
