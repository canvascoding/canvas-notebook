'use client';

import { Check, Cloud, Pencil, ServerCog } from 'lucide-react';

import type {
  AiCredentialScope,
  AiProviderSource,
  AiProviderStatus,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { AiCatalogProviderDraft } from './catalog-client';

export type AiProviderCatalogCardCopy = {
  edit: string;
  enabled: string;
  disabled: string;
  providerDefault: string;
  appDefault: string;
  selectedModels: (selected: number, total: number) => string;
  endpointNotConfigured: string;
  status: Record<AiProviderStatus, string>;
  source: Record<AiProviderSource, string>;
  scope: Record<AiCredentialScope, string>;
};

type AiProviderCatalogCardProps = {
  provider: AiCatalogProviderDraft;
  appDefault: AiRuntimeSelection | null;
  copy: AiProviderCatalogCardCopy;
  disabled?: boolean;
  onEdit: () => void;
};

function statusVariant(status: AiProviderStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ready') return 'default';
  if (status === 'degraded') return 'destructive';
  if (status === 'disabled') return 'outline';
  return 'secondary';
}

function providerEndpoint(provider: AiCatalogProviderDraft): string | null {
  if (provider.providerId === 'ollama') {
    return provider.config.ollamaHost?.trim() || 'http://localhost:11434';
  }
  if (provider.providerId === 'openai-compatible') {
    return provider.config.openaiCompatibleBaseUrl?.trim() || null;
  }
  return null;
}

export function AiProviderCatalogCard({
  provider,
  appDefault,
  copy,
  disabled = false,
  onEdit,
}: AiProviderCatalogCardProps) {
  const endpoint = providerEndpoint(provider);
  const providerDefault = provider.availableModels.find((model) => model.id === provider.defaultModelId);
  const isAppDefault = appDefault?.providerId === provider.providerId
    && (!provider.providerInstallationId
      || appDefault.providerInstallationId === provider.providerInstallationId);

  return (
    <Card
      className={cn(
        'group gap-0 overflow-hidden border-border/80 py-0 shadow-xs transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-sm',
        !provider.enabled && 'bg-muted/15',
      )}
      data-testid={`provider-summary-${provider.providerId}-${provider.credentialScope}`}
    >
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground shadow-xs">
            {provider.source === 'managed'
              ? <Cloud className="size-4.5" aria-hidden="true" />
              : <ServerCog className="size-4.5" aria-hidden="true" />}
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold sm:text-base">{provider.name}</h3>
              <Badge variant={statusVariant(provider.enabled ? provider.status : 'disabled')}>
                {copy.status[provider.enabled ? provider.status : 'disabled']}
              </Badge>
              {isAppDefault && (
                <Badge variant="outline" className="gap-1">
                  <Check className="size-3" aria-hidden="true" />
                  {copy.appDefault}
                </Badge>
              )}
            </div>
            <p className="truncate text-sm text-muted-foreground" title={endpoint ?? copy.endpointNotConfigured}>
              {endpoint ?? copy.endpointNotConfigured}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{copy.scope[provider.credentialScope]}</span>
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

        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onEdit}>
          <Pencil className="size-3.5" aria-hidden="true" />
          {copy.edit}
        </Button>
      </div>
    </Card>
  );
}
