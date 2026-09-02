'use client';

import { startTransition, useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  KeyRound,
  Loader2,
  Network,
  Plus,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { ProviderInstallationCredentialEditor } from '@/app/components/settings/ProviderInstallationCredentialEditor';
import { getAllowedCredentialScopesForProvider } from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import type {
  AiCatalogDiscoveryModel,
  AiCredentialScope,
  AiProviderSafeConfig,
} from '@/app/lib/agent-runtime-policy/types';
import { defaultOllamaServerUrl, normalizeOllamaServerUrl } from '@/app/lib/agent-runtime-policy/ollama-url';
import { getAuthMethodForProvider } from '@/app/lib/pi/provider-help';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import type { AiCatalogProviderDraft } from './catalog-client';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;

export type AiProviderEditorCopy = {
  addTitle: string;
  editTitle: string;
  description: string;
  connectionStep: string;
  connectionDescription: string;
  modelsStep: string;
  modelsDescription: string;
  accessStep: string;
  accessDescription: string;
  serverUrl: string;
  serverUrlHint: string;
  serverUrlPlaceholder: string;
  apiKey: string;
  apiKeyOptional: string;
  apiKeyPlaceholder: string;
  testConnection: string;
  testingConnection: string;
  connectionReady: (count: number) => string;
  noRemoteModels: string;
  discoverFirst: string;
  manualModel: string;
  manualModelPlaceholder: string;
  addModel: string;
  searchModels: string;
  allowed: string;
  providerDefault: string;
  noModels: string;
  authentication: string;
  apiKeyAuthentication: string;
  oauthAuthentication: string;
  credentialScope: string;
  providerEnabled: string;
  providerEnabledHint: string;
  credentials: string;
  credentialsDescription: string;
  cancel: string;
  save: string;
  saveAndVerify: string;
  saving: string;
  remove: string;
  errors: {
    invalidUrl: string;
    invalidModel: string;
    enabledNeedsModel: string;
    defaultRequired: string;
    discovery: string;
    credentialLoad: string;
    credentialSave: string;
  };
  scope: Record<AiCredentialScope, string>;
};

type DiscoveryResponse = {
  success?: boolean;
  data?: {
    serverUrl: string;
    models: Array<{
      id: string;
      name: string;
    }>;
  };
  error?: string;
};

type EnvResponse = {
  success?: boolean;
  data?: {
    entries: Array<{ key: string; value: string }>;
  };
  error?: string;
};

type AiProviderEditorDialogProps = {
  open: boolean;
  provider: AiCatalogProviderDraft | null;
  copy: AiProviderEditorCopy;
  locale?: string;
  isNew?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (provider: AiCatalogProviderDraft, options: { verify: boolean }) => Promise<void>;
  onRemove?: (provider: AiCatalogProviderDraft) => Promise<void>;
};

function customModelMetadata(modelId: string): AiCatalogDiscoveryModel {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    supportsVision: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function serializeProvider(provider: AiCatalogProviderDraft | null): string {
  return provider ? JSON.stringify(provider) : '';
}

function compactConfig(config: AiProviderSafeConfig): AiProviderSafeConfig {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => (
    value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)
  ))) as AiProviderSafeConfig;
}

export function AiProviderEditorDialog({
  open,
  provider,
  copy,
  locale,
  isNew = false,
  onOpenChange,
  onSave,
  onRemove,
}: AiProviderEditorDialogProps) {
  const [draft, setDraft] = useState<AiCatalogProviderDraft | null>(provider);
  const [baseline, setBaseline] = useState(serializeProvider(provider));
  const [busyAction, setBusyAction] = useState<'save' | 'save-verify' | 'remove' | 'discover' | null>(null);
  const [search, setSearch] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [ollamaApiKey, setOllamaApiKey] = useState('');
  const [ollamaApiKeyBaseline, setOllamaApiKeyBaseline] = useState('');
  const [credentialLoading, setCredentialLoading] = useState(false);

  useEffect(() => {
    if (!open || !provider) return;
    const nextProvider = provider.providerId === 'ollama'
      ? {
          ...provider,
          config: {
            ...provider.config,
            ollamaHost: provider.config.ollamaHost?.trim() || defaultOllamaServerUrl(),
            ollamaAdditionalModels: Array.from(new Set([
              ...(provider.config.ollamaAdditionalModels ?? []),
              ...(provider.config.ollamaCustomModel?.trim() ? [provider.config.ollamaCustomModel.trim()] : []),
            ])),
            ollamaModelSource: undefined,
            ollamaCustomModel: undefined,
          },
        }
      : provider;
    startTransition(() => {
      setDraft(nextProvider);
      setBaseline(serializeProvider(nextProvider));
      setSearch('');
      setManualModel('');
      setError(null);
      setConnectionMessage(null);
      setConnectionChecked(false);
    });
  }, [open, provider]);

  useEffect(() => {
    if (!open || draft?.providerId !== 'ollama' || draft.credentialScope === 'managed') return;
    let cancelled = false;
    startTransition(() => setCredentialLoading(true));
    void fetch(
      `/api/integrations/env?scope=agents&secretScope=${draft.credentialScope}&key=OLLAMA_API_KEY`,
      { credentials: 'include', cache: 'no-store' },
    )
      .then(async (response) => {
        const payload = await response.json() as EnvResponse;
        if (!response.ok || !payload.success || !payload.data) {
          throw new Error(payload.error || copy.errors.credentialLoad);
        }
        const value = payload.data.entries.find((entry) => entry.key === 'OLLAMA_API_KEY')?.value ?? '';
        if (!cancelled) {
          setOllamaApiKey(value);
          setOllamaApiKeyBaseline(value);
        }
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : copy.errors.credentialLoad);
      })
      .finally(() => {
        if (!cancelled) setCredentialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [copy.errors.credentialLoad, draft?.credentialScope, draft?.providerId, open]);

  const isDirty = serializeProvider(draft) !== baseline || ollamaApiKey !== ollamaApiKeyBaseline;
  const isOllama = draft?.providerId === 'ollama';
  const isOpenAiCompatible = draft?.providerId === 'openai-compatible';
  const authContract = draft ? getAuthMethodForProvider(draft.providerId) : 'api-key';
  const supportsAuthChoice = authContract === 'both';
  const credentialScopes = draft
    ? getAllowedCredentialScopesForProvider(draft.providerId, draft.config.authMethod)
    : [];
  const selectedModelIds = useMemo(() => new Set(draft?.modelIds ?? []), [draft?.modelIds]);
  const shownModels = useMemo(() => {
    if (!draft) return [];
    const query = search.trim().toLocaleLowerCase();
    const currentModels = isOllama && !connectionChecked
      ? draft.availableModels.filter((model) => (
          selectedModelIds.has(model.id)
          || draft.config.ollamaAdditionalModels?.includes(model.id)
        ))
      : draft.availableModels;
    return currentModels.filter((model) => (
      !query
      || model.name.toLocaleLowerCase().includes(query)
      || model.id.toLocaleLowerCase().includes(query)
    ));
  }, [connectionChecked, draft, isOllama, search, selectedModelIds]);

  const updateDraft = (updater: (current: AiCatalogProviderDraft) => AiCatalogProviderDraft) => {
    setDraft((current) => current ? updater(current) : current);
    setError(null);
  };

  const requestClose = (nextOpen: boolean) => {
    if (!nextOpen && isDirty && !window.confirm(locale?.toLowerCase().startsWith('de')
      ? 'Ungespeicherte Änderungen verwerfen?'
      : 'Discard unsaved changes?')) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const discoverModels = async () => {
    if (!draft || !isOllama) return;
    let serverUrl: string;
    try {
      serverUrl = normalizeOllamaServerUrl(draft.config.ollamaHost);
    } catch {
      setError(copy.errors.invalidUrl);
      return;
    }
    setBusyAction('discover');
    setError(null);
    setConnectionMessage(null);
    try {
      const response = await fetch('/api/admin/agent-runtime/providers/ollama/discover', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl,
          ...(ollamaApiKey.trim() ? { apiKey: ollamaApiKey } : {}),
        }),
      });
      const payload = await response.json() as DiscoveryResponse;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || copy.errors.discovery);
      }
      updateDraft((current) => {
        const preserved = current.availableModels.filter((model) => (
          current.modelIds.includes(model.id)
          || current.config.ollamaAdditionalModels?.includes(model.id)
        ));
        const models = new Map<string, AiCatalogDiscoveryModel>();
        for (const model of [...preserved, ...payload.data!.models.map((entry) => customModelMetadata(entry.id))]) {
          models.set(model.id, { ...model, name: model.name || model.id });
        }
        const discoveredIds = payload.data!.models.map((model) => model.id);
        return {
          ...current,
          config: compactConfig({
            ...current.config,
            ollamaHost: payload.data!.serverUrl,
            ollamaAdditionalModels: Array.from(new Set([
              ...(current.config.ollamaAdditionalModels ?? []),
              ...discoveredIds,
            ])),
          }),
          availableModels: Array.from(models.values()).sort((left, right) => left.name.localeCompare(right.name)),
          status: current.enabled ? 'unverified' : 'disabled',
        };
      });
      setConnectionChecked(true);
      setConnectionMessage(
        payload.data.models.length > 0
          ? copy.connectionReady(payload.data.models.length)
          : copy.noRemoteModels,
      );
    } catch (discoveryError) {
      setConnectionChecked(false);
      setError(discoveryError instanceof Error ? discoveryError.message : copy.errors.discovery);
    } finally {
      setBusyAction(null);
    }
  };

  const addManualModel = () => {
    if (!draft) return;
    const modelId = manualModel.trim();
    if (!MODEL_ID_PATTERN.test(modelId)) {
      setError(copy.errors.invalidModel);
      return;
    }
    updateDraft((current) => {
      const models = new Map(current.availableModels.map((model) => [model.id, model]));
      const previousOpenAiCustomModel = current.config.openaiCompatibleCustomModel?.trim();
      if (current.providerId === 'openai-compatible' && previousOpenAiCustomModel && previousOpenAiCustomModel !== modelId) {
        models.delete(previousOpenAiCustomModel);
      }
      if (!models.has(modelId)) models.set(modelId, customModelMetadata(modelId));
      const modelIds = current.providerId === 'openai-compatible'
        ? Array.from(new Set([
            ...current.modelIds.filter((id) => id !== previousOpenAiCustomModel),
            modelId,
          ]))
        : current.modelIds;
      return {
        ...current,
        config: current.providerId === 'ollama'
          ? compactConfig({
              ...current.config,
              ollamaAdditionalModels: Array.from(new Set([
                ...(current.config.ollamaAdditionalModels ?? []),
                modelId,
              ])),
            })
          : {
              ...current.config,
              openaiCompatibleModelSource: 'custom',
              openaiCompatibleCustomModel: modelId,
            },
        modelIds,
        defaultModelId: current.providerId === 'openai-compatible'
          && (!current.defaultModelId || current.defaultModelId === previousOpenAiCustomModel)
          ? modelId
          : current.defaultModelId,
        availableModels: Array.from(models.values()).sort((left, right) => left.name.localeCompare(right.name)),
      };
    });
    setManualModel('');
  };

  const toggleModel = (model: AiCatalogDiscoveryModel, allowed: boolean) => {
    updateDraft((current) => {
      const modelIds = allowed
        ? Array.from(new Set([...current.modelIds, model.id]))
        : current.modelIds.filter((modelId) => modelId !== model.id);
      return {
        ...current,
        modelIds,
        defaultModelId: modelIds.includes(current.defaultModelId)
          ? current.defaultModelId
          : modelIds[0] ?? '',
        status: current.enabled ? 'unverified' : 'disabled',
      };
    });
  };

  const saveOllamaCredential = async (current: AiCatalogProviderDraft) => {
    if (current.providerId !== 'ollama' || ollamaApiKey === ollamaApiKeyBaseline) return;
    const query = `scope=agents&secretScope=${current.credentialScope}`;
    const response = await fetch(`/api/integrations/env?${query}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const payload = await response.json() as EnvResponse;
    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(payload.error || copy.errors.credentialSave);
    }
    const entries = new Map(payload.data.entries.map((entry) => [entry.key, entry.value]));
    if (ollamaApiKey.trim()) entries.set('OLLAMA_API_KEY', ollamaApiKey.trim());
    else entries.delete('OLLAMA_API_KEY');
    const saveResponse = await fetch('/api/integrations/env', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'agents',
        secretScope: current.credentialScope,
        mode: 'kv',
        entries: Array.from(entries, ([key, value]) => ({ key, value })),
      }),
    });
    const saved = await saveResponse.json() as EnvResponse;
    if (!saveResponse.ok || !saved.success) {
      throw new Error(saved.error || copy.errors.credentialSave);
    }
  };

  const save = async (verify: boolean) => {
    if (!draft) return;
    if (isOllama) {
      try {
        normalizeOllamaServerUrl(draft.config.ollamaHost);
      } catch {
        setError(copy.errors.invalidUrl);
        return;
      }
    }
    if (draft.enabled && draft.modelIds.length === 0) {
      setError(copy.errors.enabledNeedsModel);
      return;
    }
    if (draft.modelIds.length > 0 && !draft.modelIds.includes(draft.defaultModelId)) {
      setError(copy.errors.defaultRequired);
      return;
    }
    setBusyAction(verify ? 'save-verify' : 'save');
    setError(null);
    try {
      await saveOllamaCredential(draft);
      await onSave({
        ...draft,
        config: compactConfig(draft.config),
      }, { verify });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : copy.errors.credentialSave);
    } finally {
      setBusyAction(null);
    }
  };

  const remove = async () => {
    if (!draft || !onRemove) return;
    const confirmed = window.confirm(locale?.toLowerCase().startsWith('de')
      ? `Provider „${draft.name}“ wirklich entfernen?`
      : `Remove provider “${draft.name}”?`);
    if (!confirmed) return;
    setBusyAction('remove');
    setError(null);
    try {
      await onRemove(draft);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : copy.errors.credentialSave);
    } finally {
      setBusyAction(null);
    }
  };

  if (!draft) return null;

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        layout="viewport"
        className="!flex min-w-0 flex-col gap-0 overflow-x-hidden p-0 sm:!inset-auto sm:!left-1/2 sm:!top-1/2 sm:!h-[calc(100dvh-2rem)] sm:!w-[calc(100vw-2rem)] sm:!max-w-4xl sm:!-translate-x-1/2 sm:!-translate-y-1/2"
        data-testid="provider-editor-dialog"
      >
        <DialogHeader className="border-b px-5 py-5 pr-12 sm:px-7">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/35 text-muted-foreground">
              <ServerCog className="size-4.5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <DialogTitle>{isNew ? copy.addTitle : copy.editTitle}: {draft.name}</DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10">
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6 sm:px-7">
            {error && (
              <div role="alert" className="rounded-lg border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <section className="rounded-xl border bg-background p-4 shadow-xs sm:p-5">
              <div className="mb-5 flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">1</div>
                <div>
                  <h3 className="font-semibold">{copy.connectionStep}</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">{copy.connectionDescription}</p>
                </div>
              </div>

              {isOllama ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="ollama-server-url">{copy.serverUrl}</Label>
                    <Input
                      id="ollama-server-url"
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={draft.config.ollamaHost ?? ''}
                      placeholder={copy.serverUrlPlaceholder}
                      disabled={busyAction !== null}
                      onChange={(event) => updateDraft((current) => ({
                        ...current,
                        config: { ...current.config, ollamaHost: event.target.value },
                        status: current.enabled ? 'unverified' : 'disabled',
                      }))}
                      data-testid="ollama-server-url"
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">{copy.serverUrlHint}</p>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="ollama-api-key">{copy.apiKey}</Label>
                      <span className="text-xs text-muted-foreground">{copy.apiKeyOptional}</span>
                    </div>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="ollama-api-key"
                        type="password"
                        value={ollamaApiKey}
                        placeholder={copy.apiKeyPlaceholder}
                        className="pl-9"
                        disabled={credentialLoading || busyAction !== null}
                        onChange={(event) => setOllamaApiKey(event.target.value)}
                      />
                      {credentialLoading && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-2 text-sm">
                      {connectionChecked
                        ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                        : <Network className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                      <span className={connectionChecked ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>
                        {connectionMessage || copy.discoverFirst}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyAction !== null || credentialLoading}
                      onClick={() => void discoverModels()}
                      data-testid="ollama-discover-models"
                    >
                      {busyAction === 'discover' ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                      {busyAction === 'discover' ? copy.testingConnection : copy.testConnection}
                    </Button>
                  </div>
                </div>
              ) : isOpenAiCompatible ? (
                <div className="space-y-2">
                  <Label htmlFor="openai-compatible-url">{copy.serverUrl}</Label>
                  <Input
                    id="openai-compatible-url"
                    type="url"
                    value={draft.config.openaiCompatibleBaseUrl ?? ''}
                    placeholder={copy.serverUrlPlaceholder}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      config: {
                        ...current.config,
                        openaiCompatibleBaseUrl: event.target.value,
                        openaiCompatibleModelSource: 'custom',
                      },
                    }))}
                  />
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/15 p-4">
                  <ProviderInstallationCredentialEditor
                    installation={{
                      installationId: draft.providerInstallationId ?? draft.clientKey,
                      providerId: draft.providerId,
                      name: draft.name,
                      credentialScope: draft.credentialScope,
                      authMethod: draft.config.authMethod,
                    }}
                    locale={locale}
                    showIdentity={false}
                  />
                </div>
              )}
            </section>

            <section className="rounded-xl border bg-background p-4 shadow-xs sm:p-5">
              <div className="mb-5 flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">2</div>
                <div>
                  <h3 className="font-semibold">{copy.modelsStep}</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">{copy.modelsDescription}</p>
                </div>
              </div>

              {(isOllama || isOpenAiCompatible) && (
                <div className="mb-4 flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={manualModel}
                    onChange={(event) => setManualModel(event.target.value)}
                    placeholder={copy.manualModelPlaceholder}
                    aria-label={copy.manualModel}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addManualModel();
                      }
                    }}
                    data-testid="provider-custom-model-input"
                  />
                  <Button type="button" variant="outline" onClick={addManualModel} disabled={!manualModel.trim()}>
                    <Plus className="size-3.5" />
                    {copy.addModel}
                  </Button>
                </div>
              )}

              <div className="relative mb-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={copy.searchModels}
                  className="pl-9"
                />
              </div>

              {shownModels.length > 0 ? (
                <div className="max-h-80 divide-y overflow-y-auto rounded-lg border" data-testid="provider-model-list">
                  {shownModels.map((model) => {
                    const checked = selectedModelIds.has(model.id);
                    const isDefault = draft.defaultModelId === model.id;
                    return (
                      <div
                        key={model.id}
                        className={cn('flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between', checked && 'bg-primary/[0.035]')}
                        data-testid={`provider-model-${model.id}`}
                      >
                        <label className="flex min-w-0 cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => toggleModel(model, event.target.checked)}
                            className="mt-0.5 size-4 accent-primary"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{model.name}</span>
                            <span className="block break-all font-mono text-[11px] text-muted-foreground">{model.id}</span>
                          </span>
                        </label>
                        <label className={cn('flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground', !checked && 'pointer-events-none opacity-40')}>
                          <input
                            type="radio"
                            name={`provider-default-${draft.clientKey}`}
                            checked={isDefault}
                            disabled={!checked}
                            onChange={() => updateDraft((current) => ({ ...current, defaultModelId: model.id }))}
                            className="size-4 accent-primary"
                          />
                          {copy.providerDefault}
                        </label>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                  {isOllama && !connectionChecked ? copy.discoverFirst : copy.noModels}
                </div>
              )}
            </section>

            <section className="rounded-xl border bg-background p-4 shadow-xs sm:p-5">
              <div className="mb-5 flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">3</div>
                <div>
                  <h3 className="font-semibold">{copy.accessStep}</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">{copy.accessDescription}</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {supportsAuthChoice && (
                  <div className="space-y-2">
                    <Label htmlFor="provider-auth-method">{copy.authentication}</Label>
                    <select
                      id="provider-auth-method"
                      value={draft.config.authMethod === 'oauth' ? 'oauth' : 'api-key'}
                      onChange={(event) => {
                        const authMethod = event.target.value as 'api-key' | 'oauth';
                        const scopes = getAllowedCredentialScopesForProvider(draft.providerId, authMethod);
                        updateDraft((current) => ({
                          ...current,
                          credentialScope: scopes.includes(current.credentialScope) ? current.credentialScope : scopes[0],
                          config: { ...current.config, authMethod },
                        }));
                      }}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="api-key">{copy.apiKeyAuthentication}</option>
                      <option value="oauth">{copy.oauthAuthentication}</option>
                    </select>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="provider-credential-scope">{copy.credentialScope}</Label>
                  <select
                    id="provider-credential-scope"
                    value={draft.credentialScope}
                    disabled={credentialScopes.length <= 1}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      credentialScope: event.target.value as AiCredentialScope,
                    }))}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
                  >
                    {credentialScopes.map((scope) => <option key={scope} value={scope}>{copy.scope[scope]}</option>)}
                  </select>
                </div>
                <div className={cn('flex items-center justify-between gap-4 rounded-lg border bg-muted/15 p-3', supportsAuthChoice ? 'sm:col-span-2' : '')}>
                  <div>
                    <p className="text-sm font-medium">{copy.providerEnabled}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{copy.providerEnabledHint}</p>
                  </div>
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(enabled) => updateDraft((current) => ({
                      ...current,
                      enabled,
                      status: enabled ? 'unverified' : 'disabled',
                    }))}
                    aria-label={copy.providerEnabled}
                    data-testid="provider-enabled-switch"
                  />
                </div>
              </div>

              {(isOllama || isOpenAiCompatible) && (
                <div className="mt-4 rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">{copy.credentials}:</span> {copy.credentialsDescription}
                </div>
              )}
            </section>
          </div>
        </div>

        <DialogFooter className="border-t bg-background px-5 py-4 sm:px-7">
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {!isNew && onRemove && (
                <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busyAction !== null} onClick={() => void remove()}>
                  {busyAction === 'remove' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {copy.remove}
                </Button>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" disabled={busyAction !== null} onClick={() => requestClose(false)}>
                {copy.cancel}
              </Button>
              {draft.enabled && (
                <Button type="button" variant="outline" disabled={busyAction !== null || !isDirty} onClick={() => void save(true)} data-testid="provider-save-verify">
                  {busyAction === 'save-verify' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                  {busyAction === 'save-verify' ? copy.saving : copy.saveAndVerify}
                </Button>
              )}
              <Button type="button" disabled={busyAction !== null || !isDirty} onClick={() => void save(false)} data-testid="provider-save">
                {busyAction === 'save' ? <Loader2 className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}
                {busyAction === 'save' ? copy.saving : copy.save}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
