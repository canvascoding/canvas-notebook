'use client';

import { useMemo, useState } from 'react';
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Cloud,
  Eye,
  Search,
  ServerCog,
  ShieldCheck,
  Loader2,
  Trash2,
} from 'lucide-react';

import type {
  AiCatalogDiscoveryModel,
  AiCredentialScope,
  AiProviderSource,
  AiProviderStatus,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import type { AiCatalogProviderDraft } from './catalog-client';

const STANDARD_CREDENTIAL_SCOPES: AiCredentialScope[] = ['system', 'organization', 'user'];
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
  onModelAllowedChange: (model: AiCatalogDiscoveryModel, allowed: boolean) => void;
  onProviderDefaultChange: (model: AiCatalogDiscoveryModel) => void;
  onRemove: () => void;
  onVerify?: () => void;
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
  onModelAllowedChange,
  onProviderDefaultChange,
  onRemove,
  onVerify,
}: AiProviderCatalogCardProps) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const isManaged = provider.source === 'managed' || provider.credentialScope === 'managed';
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
          <div className="space-y-2">
            <Label htmlFor={`${provider.clientKey}-credential-scope`}>{copy.credentialScope}</Label>
            <div className="relative">
              <select
                id={`${provider.clientKey}-credential-scope`}
                value={provider.credentialScope}
                disabled={disabled || isManaged}
                onChange={(event) => onCredentialScopeChange(event.target.value as AiCredentialScope)}
                className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              >
                {(isManaged ? ['managed'] as const : STANDARD_CREDENTIAL_SCOPES).map((scope) => (
                  <option key={scope} value={scope}>{copy.scope[scope]}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            </div>
            {isManaged && <p className="text-xs text-muted-foreground">{copy.managedScopeLocked}</p>}
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
