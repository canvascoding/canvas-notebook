'use client';

import { useMemo } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PiRuntimeConfig, PiThinkingLevel } from '@/app/lib/pi/config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const CANVAS_CONTROL_PLANE_PROVIDER_ID = 'canvas-control-plane';
const CREATE_AGENT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly PiThinkingLevel[];

export type CreateAgentModelDiscovery = Record<string, { models: { id: string; name: string; reasoning?: boolean; supportsVision?: boolean }[] }>;

export type CreateAgentModelDraft = {
  provider: string;
  model: string;
  thinking: PiThinkingLevel;
};

function getModelOptions(providerId: string, piConfig: PiRuntimeConfig | null, discovery: CreateAgentModelDiscovery) {
  const discoveredModels = discovery[providerId]?.models || [];
  const configuredModel = piConfig?.providers[providerId]?.model?.trim() || '';
  if (!configuredModel || discoveredModels.some((model) => model.id === configuredModel)) {
    return discoveredModels;
  }

  return [
    ...discoveredModels,
    { id: configuredModel, name: configuredModel },
  ];
}

function getModelProviders(piConfig: PiRuntimeConfig | null, discovery: CreateAgentModelDiscovery): string[] {
  if (!piConfig) return [];
  const providerIds = new Set([
    ...Object.keys(discovery),
    ...Object.keys(piConfig.providers || {}),
  ]);

  return [...providerIds]
    .filter((providerId) => providerId !== CANVAS_CONTROL_PLANE_PROVIDER_ID)
    .filter((providerId) => {
      if (providerId === 'openai-compatible') return true;
      return getModelOptions(providerId, piConfig, discovery).length > 0;
    })
    .sort();
}

export function getInitialCreateAgentModelDraft(
  piConfig: PiRuntimeConfig,
  discovery: CreateAgentModelDiscovery,
): CreateAgentModelDraft {
  const providers = getModelProviders(piConfig, discovery);
  const inheritedProvider = piConfig.activeProvider !== CANVAS_CONTROL_PLANE_PROVIDER_ID && providers.includes(piConfig.activeProvider)
    ? piConfig.activeProvider
    : providers[0] || '';
  const providerConfig = inheritedProvider ? piConfig.providers[inheritedProvider] : null;
  const modelOptions = inheritedProvider ? getModelOptions(inheritedProvider, piConfig, discovery) : [];

  return {
    provider: inheritedProvider,
    model: providerConfig?.model?.trim() || modelOptions[0]?.id || '',
    thinking: providerConfig?.thinking || 'off',
  };
}

type CreateAgentModelOverrideEditorProps = {
  piConfig: PiRuntimeConfig | null;
  discovery: CreateAgentModelDiscovery;
  draft: CreateAgentModelDraft;
  loading: boolean;
  error: string | null;
  onDraftChange: (draft: CreateAgentModelDraft) => void;
  onRetry: () => void;
};

export function CreateAgentModelOverrideEditor({
  piConfig,
  discovery,
  draft,
  loading,
  error,
  onDraftChange,
  onRetry,
}: CreateAgentModelOverrideEditorProps) {
  const t = useTranslations('settings.agentPanel.createDialog.model');
  const providerT = useTranslations('settings.provider');
  const providers = useMemo(() => getModelProviders(piConfig, discovery), [discovery, piConfig]);
  const modelOptions = useMemo(
    () => getModelOptions(draft.provider, piConfig, discovery),
    [discovery, draft.provider, piConfig],
  );
  const selectedModelIsListed = modelOptions.some((model) => model.id === draft.model);

  if (loading) {
    return (
      <div className="flex min-h-24 items-center justify-center gap-2 rounded-md border border-dashed bg-background/70 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <p className="text-destructive">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('retry')}
        </Button>
      </div>
    );
  }

  if (!piConfig || providers.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-background/70 p-3 text-sm text-muted-foreground">
        {t('empty')}
      </div>
    );
  }

  const handleProviderChange = (provider: string) => {
    const providerConfig = piConfig.providers[provider];
    const nextOptions = getModelOptions(provider, piConfig, discovery);
    onDraftChange({
      provider,
      model: providerConfig?.model?.trim() || nextOptions[0]?.id || '',
      thinking: providerConfig?.thinking || draft.thinking || 'off',
    });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="grid min-w-0 gap-3 md:grid-cols-3">
        <label className="min-w-0 space-y-1.5 text-sm">
          <span className="font-medium">{t('providerLabel')}</span>
          <select
            className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={draft.provider}
            onChange={(event) => handleProviderChange(event.target.value)}
          >
            <option value="" disabled>{providerT('selectProvider')}</option>
            {providers.map((providerId) => (
              <option key={providerId} value={providerId}>
                {providerId}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0 space-y-1.5 text-sm md:col-span-2">
          <span className="font-medium">{t('modelLabel')}</span>
          {draft.provider === 'openai-compatible' ? (
            <Input
              value={draft.model}
              onChange={(event) => onDraftChange({ ...draft, model: event.target.value })}
              placeholder={providerT('openaiCompatibleCustomModelPlaceholder')}
            />
          ) : (
            <select
              className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={draft.model}
              onChange={(event) => onDraftChange({ ...draft, model: event.target.value })}
              disabled={!draft.provider}
            >
              <option value="" disabled>{providerT('selectModel')}</option>
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || model.id}
                </option>
              ))}
              {draft.model && !selectedModelIsListed && (
                <option value={draft.model}>{draft.model}</option>
              )}
            </select>
          )}
        </label>
      </div>

      <label className="block max-w-xs space-y-1.5 text-sm">
        <span className="font-medium">{t('thinkingLabel')}</span>
        <select
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          value={draft.thinking}
          onChange={(event) => onDraftChange({ ...draft, thinking: event.target.value as PiThinkingLevel })}
        >
          {CREATE_AGENT_THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {providerT(`thinkingLevels.${level}`)}
            </option>
          ))}
        </select>
      </label>

      <p className="text-xs text-muted-foreground">{t('hint')}</p>
    </div>
  );
}
