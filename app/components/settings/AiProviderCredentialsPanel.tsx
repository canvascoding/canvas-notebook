'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, KeyRound, Loader2, RefreshCw } from 'lucide-react';

import type { AiAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

import { ProviderInstallationCredentialEditor } from './ProviderInstallationCredentialEditor';

type CatalogResponse = {
  success?: boolean;
  data?: { catalog?: AiAppRuntimeCatalog };
  error?: string;
};

type AiProviderCredentialsPanelProps = {
  locale?: string;
  refreshKey?: number;
  onCredentialsSaved?: () => void;
};

const COPY = {
  de: {
    title: 'Provider-Zugangsdaten',
    description: 'Konfiguriere jede installierte Provider-/Scope-Kombination getrennt vom Modellkatalog.',
    loading: 'Provider-Installationen werden geladen …',
    loadError: 'Die Provider-Installationen konnten nicht geladen werden.',
    retry: 'Erneut laden',
    noProviders: 'Lege zuerst mindestens eine Provider-Installation im Modellkatalog an und speichere sie.',
    installation: 'Provider-Installation',
    chooseInstallation: 'Provider-Installation auswählen',
    appDefault: 'App-Standard',
    scope: {
      managed: 'Managed · Control Plane',
      system: 'Systemweit',
      organization: 'Organisation',
      user: 'Pro Nutzer',
    },
  },
  en: {
    title: 'Provider credentials',
    description: 'Configure every installed provider/scope combination separately from the model catalog.',
    loading: 'Loading provider installations …',
    loadError: 'Provider installations could not be loaded.',
    retry: 'Reload',
    noProviders: 'Create and save at least one provider installation in the model catalog first.',
    installation: 'Provider installation',
    chooseInstallation: 'Select a provider installation',
    appDefault: 'App default',
    scope: {
      managed: 'Managed · Control Plane',
      system: 'System wide',
      organization: 'Organization',
      user: 'Per user',
    },
  },
} as const;

export function AiProviderCredentialsPanel({
  locale,
  refreshKey = 0,
  onCredentialsSaved,
}: AiProviderCredentialsPanelProps) {
  const copy = locale?.toLowerCase().startsWith('de') ? COPY.de : COPY.en;
  const [catalog, setCatalog] = useState<AiAppRuntimeCatalog | null>(null);
  const [selectedInstallationId, setSelectedInstallationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/agent-runtime/catalog', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as CatalogResponse | null;
      if (!response.ok || !payload?.success || !payload.data?.catalog) {
        throw new Error(payload?.error || copy.loadError);
      }
      const nextCatalog = payload.data.catalog;
      setCatalog(nextCatalog);
      setSelectedInstallationId((current) => {
        if (nextCatalog.providers.some((provider) => provider.installationId === current)) {
          return current;
        }
        const defaultInstallationId = nextCatalog.defaultSelection?.providerInstallationId;
        if (defaultInstallationId && nextCatalog.providers.some((provider) => (
          provider.installationId === defaultInstallationId
        ))) {
          return defaultInstallationId;
        }
        return nextCatalog.providers[0]?.installationId ?? '';
      });
    } catch (loadError) {
      setCatalog(null);
      setSelectedInstallationId('');
      setError(loadError instanceof Error ? loadError.message : copy.loadError);
    } finally {
      setLoading(false);
    }
  }, [copy.loadError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCatalog(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalog, refreshKey]);

  const provider = useMemo(() => {
    if (!catalog || !selectedInstallationId) return null;
    return catalog.providers.find((candidate) => candidate.installationId === selectedInstallationId) ?? null;
  }, [catalog, selectedInstallationId]);

  return (
    <Card id="ai-provider-credentials" className="scroll-mt-6">
      <CardHeader className="border-b bg-muted/20">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-lg">
              <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
              {copy.title}
            </CardTitle>
            <CardDescription className="mt-1">{copy.description}</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadCatalog()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            <span className="sr-only">{copy.retry}</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {copy.loading}
          </div>
        )}

        {!loading && error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        {!loading && !error && catalog?.providers.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{copy.noProviders}</p>
        )}

        {!loading && !error && catalog && catalog.providers.length > 0 && (
          <>
            <div className="space-y-2">
              <Label htmlFor="ai-provider-credential-installation">{copy.installation}</Label>
              <div className="relative">
                <select
                  id="ai-provider-credential-installation"
                  value={selectedInstallationId}
                  onChange={(event) => setSelectedInstallationId(event.target.value)}
                  className="h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="" disabled>{copy.chooseInstallation}</option>
                  {catalog.providers.map((candidate) => {
                    const isDefault = candidate.installationId === catalog.defaultSelection?.providerInstallationId;
                    return (
                      <option key={candidate.installationId} value={candidate.installationId}>
                        {candidate.name} · {copy.scope[candidate.credentialScope]}
                        {isDefault ? ` · ${copy.appDefault}` : ''}
                      </option>
                    );
                  })}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>

            {provider && (
              <ProviderInstallationCredentialEditor
                key={provider.installationId}
                locale={locale}
                installation={{
                  installationId: provider.installationId,
                  providerId: provider.providerId,
                  name: provider.name,
                  credentialScope: provider.credentialScope,
                  authMethod: provider.config.authMethod,
                }}
                onCredentialsSaved={onCredentialsSaved}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
