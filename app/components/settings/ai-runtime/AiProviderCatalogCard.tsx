'use client';

import { type ReactNode, useMemo, useState } from 'react';
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Cloud,
  Eye,
  KeyRound,
  Network,
  Search,
  ServerCog,
  ShieldCheck,
  Loader2,
  Trash2,
} from 'lucide-react';

import type {
  AiCatalogDiscoveryModel,
  AiCredentialScope,
  AiProviderSafeConfig,
  AiProviderSource,
  AiProviderStatus,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { getAllowedCredentialScopesForProvider } from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import { getAuthMethodForProvider } from '@/app/lib/pi/provider-help';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import type { AiCatalogProviderDraft } from './catalog-client';

const INITIAL_MODEL_COUNT = 8;

export type AiProviderCatalogCardCopy = {
  enabled: string;
  disabled: string;
  remove: string;
  removeAria: string;
  verify: string;
  verifying: string;
  credentialScope: string;
  providerDefault: string;
  appDefault: string;
  modelAllowlist: string;
  modelAllowlistDescription: string;
  selectedModels: (selected: number, total: number) => string;
  configureModels: string;
  collapseModels: string;
  searchModels: string;
  noModels: string;
  noModelMatches: string;
  showAll: (count: number) => string;
  showLess: string;
  reasoning: string;
  vision: string;
  contextWindow: (tokens: string) => string;
  managedScopeLocked: string;
  oauthScopeLocked: string;
  authentication: string;
  apiKeyAuthentication: string;
  oauthAuthentication: string;
  connection: string;
  connectionDescription: string;
  configureConnection: string;
  collapseConnection: string;
  selfHostedConfiguration: string;
  selfHostedDescription: string;
  openAiBaseUrl: string;
  openAiBaseUrlPlaceholder: string;
  ollamaMode: string;
  ollamaLocal: string;
  ollamaRemote: string;
  ollamaLocalDescription: string;
  ollamaRemoteHost: string;
  ollamaRemoteHostPlaceholder: string;
  modelSource: string;
  predefinedModel: string;
  customModel: string;
  customModelId: string;
  customModelPlaceholder: string;
  status: Record<AiProviderStatus, string>;
  source: Record<AiProviderSource, string>;
  scope: Record<AiCredentialScope, string>;
};

type AiProviderCatalogCardProps = {
  provider: AiCatalogProviderDraft;
  appDefault: AiRuntimeSelection | null;
  copy: AiProviderCatalogCardCopy;
  disabled?: boolean;
  verifying?: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onCredentialScopeChange: (scope: AiCredentialScope) => void;
  onConfigChange: (config: AiProviderSafeConfig) => void;
  onCustomModelChange: (modelId: string) => void;
  onModelAllowedChange: (model: AiCatalogDiscoveryModel, allowed: boolean) => void;
  onProviderDefaultChange: (model: AiCatalogDiscoveryModel) => void;
  onRemove: () => void;
  onVerify?: () => void;
  onAuthMethodChange?: (authMethod: 'api-key' | 'oauth') => void;
  credentialEditor?: ReactNode;
  initialCredentialsOpen?: boolean;
};

function statusVariant(status: AiProviderStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'default';
  if (status === 'degraded') return 'destructive';
  if (status === 'disabled') return 'outline';
  return 'secondary';
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

export function AiProviderCatalogCard({
  provider,
  appDefault,
  copy,
  disabled = false,
  verifying = false,
  onEnabledChange,
  onCredentialScopeChange,
  onConfigChange,
  onCustomModelChange,
  onModelAllowedChange,
  onProviderDefaultChange,
  onRemove,
  onVerify,
  onAuthMethodChange,
  credentialEditor,
  initialCredentialsOpen = false,
}: AiProviderCatalogCardProps) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(initialCredentialsOpen);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const isManaged = provider.source === 'managed' || provider.credentialScope === 'managed';
  const providerAuthMethod = getAuthMethodForProvider(provider.providerId);
  const supportsAuthChoice = !isManaged && providerAuthMethod === 'both';
  const selectedAuthMethod = provider.config.authMethod === 'oauth' ? 'oauth' : 'api-key';
  const credentialScopes = isManaged
    ? (['managed'] as const)
    : getAllowedCredentialScopesForProvider(provider.providerId, provider.config.authMethod);
  const isPersonalOAuthScope = !isManaged
    && credentialScopes.length === 1
    && credentialScopes[0] === 'user';
  const selectedModelIds = useMemo(() => new Set(provider.modelIds), [provider.modelIds]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredModels = useMemo(() => provider.availableModels.filter((model) => {
    if (!normalizedSearch) return true;
    return model.name.toLocaleLowerCase().includes(normalizedSearch)
      || model.id.toLocaleLowerCase().includes(normalizedSearch);
  }), [normalizedSearch, provider.availableModels]);
  const visibleModels = normalizedSearch || showAll
    ? filteredModels
    : filteredModels.slice(0, INITIAL_MODEL_COUNT);
  const providerDefault = provider.availableModels.find((model) => model.id === provider.defaultModelId);
  const isOpenAiCompatible = provider.providerId === 'openai-compatible';
  const isOllama = provider.providerId === 'ollama';
  const hasSelfHostedConfiguration = isOpenAiCompatible || isOllama;

  return (
    <Card className={cn('gap-0 overflow-hidden py-0', !provider.enabled && 'bg-muted/20')}>
      <CardHeader className="gap-4 border-b px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-xs">
              {provider.source === 'managed'
                ? <Cloud className="size-4" aria-hidden="true" />
                : <ServerCog className="size-4" aria-hidden="true" />}
            </div>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="truncate text-base">{provider.name}</CardTitle>
                <Badge variant={statusVariant(provider.enabled ? provider.status : 'disabled')}>
                  {copy.status[provider.enabled ? provider.status : 'disabled']}
                </Badge>
                {appDefault?.providerId === provider.providerId
                  && (!provider.providerInstallationId
                    || appDefault.providerInstallationId === provider.providerInstallationId) && (
                    <Badge variant="outline" className="gap-1">
                      <Check className="size-3" aria-hidden="true" />
                      {copy.appDefault}
                    </Badge>
                  )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{copy.source[provider.source]}</span>
                <span aria-hidden="true">·</span>
                <span>{copy.selectedModels(provider.modelIds.length, provider.availableModels.length)}</span>
                {providerDefault && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{copy.providerDefault}: {providerDefault.name}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
            <span className="text-sm font-medium">{provider.enabled ? copy.enabled : copy.disabled}</span>
            <Switch
              checked={provider.enabled}
              disabled={disabled}
              onCheckedChange={onEnabledChange}
              aria-label={`${provider.name}: ${provider.enabled ? copy.enabled : copy.disabled}`}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className={cn('grid gap-3', supportsAuthChoice && 'sm:grid-cols-2')}>
            {supportsAuthChoice && (
              <div className="space-y-2">
                <Label htmlFor={`${provider.clientKey}-authentication`}>{copy.authentication}</Label>
                <div className="relative">
                  <select
                    id={`${provider.clientKey}-authentication`}
                    value={selectedAuthMethod}
                    disabled={disabled}
                    onChange={(event) => onAuthMethodChange?.(event.target.value as 'api-key' | 'oauth')}
                    className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                  >
                    <option value="api-key">{copy.apiKeyAuthentication}</option>
                    <option value="oauth">{copy.oauthAuthentication}</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`${provider.clientKey}-credential-scope`}>{copy.credentialScope}</Label>
              <div className="relative">
                <select
                  id={`${provider.clientKey}-credential-scope`}
                  value={provider.credentialScope}
                  disabled={disabled || isManaged || isPersonalOAuthScope}
                  onChange={(event) => onCredentialScopeChange(event.target.value as AiCredentialScope)}
                  className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                >
                  {credentialScopes.map((scope) => (
                    <option key={scope} value={scope}>{copy.scope[scope]}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
              {isManaged && <p className="text-xs text-muted-foreground">{copy.managedScopeLocked}</p>}
              {isPersonalOAuthScope && <p className="text-xs text-muted-foreground">{copy.oauthScopeLocked}</p>}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {onVerify && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || verifying || !provider.enabled}
                onClick={onVerify}
              >
                {verifying
                  ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  : <ShieldCheck className="size-3.5" aria-hidden="true" />}
                {verifying ? copy.verifying : copy.verify}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onRemove}
              aria-label={copy.removeAria.replace('{provider}', provider.name)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {copy.remove}
            </Button>
          </div>
        </div>
      </CardHeader>

      {credentialEditor && (
        <Collapsible open={credentialsOpen} onOpenChange={setCredentialsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-5"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                  <KeyRound className="size-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{copy.connection}</span>
                  <span className="block truncate text-xs text-muted-foreground">{copy.connectionDescription}</span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {credentialsOpen ? copy.collapseConnection : copy.configureConnection}
                <ChevronDown className={cn('size-4 transition-transform', credentialsOpen && 'rotate-180')} aria-hidden="true" />
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="border-b bg-muted/10 px-4 py-4 sm:px-5">
              {credentialEditor}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      )}

      {hasSelfHostedConfiguration && (
        <div className="border-b bg-muted/10 px-4 py-4 sm:px-5">
          <div className="space-y-4 rounded-lg border bg-background p-3.5 shadow-xs">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                <Network className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold">{copy.selfHostedConfiguration}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{copy.selfHostedDescription}</p>
              </div>
            </div>

            {isOpenAiCompatible && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${provider.clientKey}-openai-base-url`}>{copy.openAiBaseUrl}</Label>
                  <Input
                    id={`${provider.clientKey}-openai-base-url`}
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={provider.config.openaiCompatibleBaseUrl ?? ''}
                    disabled={disabled}
                    placeholder={copy.openAiBaseUrlPlaceholder}
                    onChange={(event) => onConfigChange({
                      ...provider.config,
                      openaiCompatibleBaseUrl: event.target.value || undefined,
                      openaiCompatibleModelSource: 'custom',
                    })}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${provider.clientKey}-openai-model-id`}>{copy.customModelId}</Label>
                  <Input
                    id={`${provider.clientKey}-openai-model-id`}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={provider.config.openaiCompatibleCustomModel ?? ''}
                    disabled={disabled}
                    placeholder={copy.customModelPlaceholder}
                    onChange={(event) => onCustomModelChange(event.target.value)}
                  />
                </div>
              </div>
            )}

            {isOllama && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${provider.clientKey}-ollama-mode`}>{copy.ollamaMode}</Label>
                  <div className="relative">
                    <select
                      id={`${provider.clientKey}-ollama-mode`}
                      value={provider.config.ollamaMode ?? 'local'}
                      disabled={disabled}
                      onChange={(event) => {
                        const ollamaMode = event.target.value as 'local' | 'cloud';
                        onConfigChange({
                          ...provider.config,
                          ollamaMode,
                          ...(ollamaMode === 'local' ? { ollamaHost: undefined } : {}),
                        });
                      }}
                      className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                    >
                      <option value="local">{copy.ollamaLocal}</option>
                      <option value="cloud">{copy.ollamaRemote}</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {provider.config.ollamaMode === 'cloud'
                      ? copy.ollamaRemoteHostPlaceholder
                      : copy.ollamaLocalDescription}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`${provider.clientKey}-ollama-model-source`}>{copy.modelSource}</Label>
                  <div className="relative">
                    <select
                      id={`${provider.clientKey}-ollama-model-source`}
                      value={provider.config.ollamaModelSource ?? 'predefined'}
                      disabled={disabled}
                      onChange={(event) => onConfigChange({
                        ...provider.config,
                        ollamaModelSource: event.target.value as 'predefined' | 'custom',
                        ...(event.target.value === 'predefined' ? { ollamaCustomModel: undefined } : {}),
                      })}
                      className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
                    >
                      <option value="predefined">{copy.predefinedModel}</option>
                      <option value="custom">{copy.customModel}</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  </div>
                </div>

                {provider.config.ollamaMode === 'cloud' && (
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor={`${provider.clientKey}-ollama-host`}>{copy.ollamaRemoteHost}</Label>
                    <Input
                      id={`${provider.clientKey}-ollama-host`}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={provider.config.ollamaHost ?? ''}
                      disabled={disabled}
                      placeholder={copy.ollamaRemoteHostPlaceholder}
                      onChange={(event) => onConfigChange({
                        ...provider.config,
                        ollamaMode: 'cloud',
                        ollamaHost: event.target.value || undefined,
                      })}
                    />
                  </div>
                )}

                {provider.config.ollamaModelSource === 'custom' && (
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor={`${provider.clientKey}-ollama-model-id`}>{copy.customModelId}</Label>
                    <Input
                      id={`${provider.clientKey}-ollama-model-id`}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={provider.config.ollamaCustomModel ?? ''}
                      disabled={disabled}
                      placeholder={copy.customModelPlaceholder}
                      onChange={(event) => onCustomModelChange(event.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Collapsible open={modelsOpen} onOpenChange={setModelsOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-5"
          >
            <span>
              {copy.modelAllowlist}
              <span className="ml-2 font-normal text-muted-foreground">
                {copy.selectedModels(provider.modelIds.length, provider.availableModels.length)}
              </span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {modelsOpen ? copy.collapseModels : copy.configureModels}
              <ChevronDown className={cn('size-4 transition-transform', modelsOpen && 'rotate-180')} aria-hidden="true" />
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4 border-t bg-muted/10 px-4 py-4 sm:px-5">
            <div className="space-y-1">
              <p className="text-sm font-medium">{copy.modelAllowlist}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.modelAllowlistDescription}</p>
            </div>

            {provider.availableModels.length > 0 ? (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    value={search}
                    disabled={disabled}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={copy.searchModels}
                    aria-label={copy.searchModels}
                    className="pl-9"
                  />
                </div>

                <div className="max-h-80 space-y-2 overflow-y-auto pr-1" role="list">
                  {visibleModels.map((model) => {
                    const isAllowed = selectedModelIds.has(model.id);
                    const isProviderDefault = provider.defaultModelId === model.id;
                    const isAppDefault = appDefault?.modelId === model.id
                      && appDefault.providerId === provider.providerId
                      && (!provider.providerInstallationId
                        || appDefault.providerInstallationId === provider.providerInstallationId);
                    const checkboxId = `${provider.clientKey}-${model.id}-allowed`;
                    const radioId = `${provider.clientKey}-${model.id}-default`;
                    return (
                      <div
                        key={model.id}
                        role="listitem"
                        className={cn(
                          'grid gap-3 rounded-lg border bg-background p-3 transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
                          isAllowed && 'border-primary/30 bg-primary/[0.025]',
                        )}
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          <input
                            id={checkboxId}
                            type="checkbox"
                            checked={isAllowed}
                            disabled={disabled}
                            onChange={(event) => onModelAllowedChange(model, event.target.checked)}
                            className="mt-0.5 size-4 shrink-0 accent-primary"
                          />
                          <div className="min-w-0 space-y-1.5">
                            <label htmlFor={checkboxId} className="block cursor-pointer text-sm font-medium leading-tight">
                              {model.name}
                            </label>
                            <p className="break-all font-mono text-[11px] text-muted-foreground">{model.id}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {model.reasoning && (
                                <Badge variant="secondary" className="gap-1 font-normal">
                                  <BrainCircuit className="size-3" aria-hidden="true" />
                                  {copy.reasoning}
                                </Badge>
                              )}
                              {model.supportsVision && (
                                <Badge variant="secondary" className="gap-1 font-normal">
                                  <Eye className="size-3" aria-hidden="true" />
                                  {copy.vision}
                                </Badge>
                              )}
                              {model.contextWindow && (
                                <Badge variant="outline" className="font-normal">
                                  {copy.contextWindow(compactNumber(model.contextWindow))}
                                </Badge>
                              )}
                              {isAppDefault && <Badge variant="default">{copy.appDefault}</Badge>}
                            </div>
                          </div>
                        </div>

                        <label
                          htmlFor={radioId}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors',
                            isProviderDefault ? 'border-primary/40 bg-primary/5 text-primary' : 'text-muted-foreground',
                            !isAllowed && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <input
                            id={radioId}
                            type="radio"
                            name={`provider-default-${provider.clientKey}`}
                            checked={isProviderDefault}
                            disabled={disabled || !isAllowed}
                            onChange={() => onProviderDefaultChange(model)}
                            className="size-4 accent-primary"
                          />
                          {copy.providerDefault}
                        </label>
                      </div>
                    );
                  })}
                  {visibleModels.length === 0 && (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      {copy.noModelMatches}
                    </div>
                  )}
                </div>

                {!normalizedSearch && filteredModels.length > INITIAL_MODEL_COUNT && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((current) => !current)}>
                    {showAll ? copy.showLess : copy.showAll(filteredModels.length - INITIAL_MODEL_COUNT)}
                  </Button>
                )}
              </>
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {copy.noModels}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
