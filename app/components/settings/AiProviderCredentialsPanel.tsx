'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, KeyRound, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import type { AiAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/types';
import { getAuthMethodForProvider, getProviderHelp } from '@/app/lib/pi/provider-help';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { PiOAuthButton } from './PiOAuthButton';
import { ProviderEnvEditor } from './ProviderEnvEditor';

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
    title: 'Zugangsdaten des App-Standards',
    description: 'Keys und OAuth-Tokens werden getrennt vom Modellkatalog im passenden Secret-Scope gespeichert.',
    loading: 'Provider wird geladen …',
    loadError: 'Der aktuelle App-Standard konnte nicht geladen werden.',
    retry: 'Erneut laden',
    noDefault: 'Lege zuerst im Katalog einen App-Standard fest und speichere ihn.',
    managed: 'Die Zugangsdaten werden sicher durch die verbundene Canvas Control Plane bereitgestellt.',
    noFields: 'Für diesen Provider sind keine Zugangsdatenfelder in der App hinterlegt.',
    integrations: 'Integrations-Variablen öffnen',
    oauthScope: 'OAuth-Verbindungen sind persönlich. Verwende für diesen Provider den Credential-Scope „Pro Nutzer“ oder API-Key-Authentifizierung.',
    provider: 'Provider',
    scope: 'Credential-Scope',
  },
  en: {
    title: 'App-default credentials',
    description: 'Keys and OAuth tokens are stored separately from the model catalog in the appropriate secret scope.',
    loading: 'Loading provider …',
    loadError: 'The current app default could not be loaded.',
    retry: 'Reload',
    noDefault: 'Choose and save an app default in the catalog first.',
    managed: 'Credentials are supplied securely by the connected Canvas Control Plane.',
    noFields: 'No in-app credential fields are registered for this provider.',
    integrations: 'Open integration variables',
    oauthScope: 'OAuth connections are personal. Use the per-user credential scope for this provider or API-key authentication.',
    provider: 'Provider',
    scope: 'Credential scope',
  },
} as const;

export function AiProviderCredentialsPanel({
  locale,
  refreshKey = 0,
  onCredentialsSaved,
}: AiProviderCredentialsPanelProps) {
  const copy = locale?.toLowerCase().startsWith('de') ? COPY.de : COPY.en;
  const [catalog, setCatalog] = useState<AiAppRuntimeCatalog | null>(null);
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
      setCatalog(payload.data.catalog);
    } catch (loadError) {
      setCatalog(null);
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
    const installationId = catalog?.defaultSelection?.providerInstallationId;
    return installationId
      ? catalog?.providers.find((candidate) => candidate.installationId === installationId) ?? null
      : null;
  }, [catalog]);
  const help = provider ? getProviderHelp(provider.providerId) : undefined;
  const wantsOAuth = Boolean(provider && (
    provider.config.authMethod === 'oauth' || getAuthMethodForProvider(provider.providerId) === 'oauth'
  ));

  return (
    <Card>
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

        {!loading && !error && !provider && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{copy.noDefault}</p>
        )}

        {!loading && provider && (
          <>
            <dl className="grid gap-3 rounded-md border bg-muted/10 p-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.provider}</dt>
                <dd className="mt-1 font-medium">{provider.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.scope}</dt>
                <dd className="mt-1 font-medium">{provider.credentialScope}</dd>
              </div>
            </dl>

            {provider.credentialScope === 'managed' ? (
              <div className="flex items-start gap-3 rounded-md border border-primary/25 bg-primary/5 p-4 text-sm">
                <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                <p>{copy.managed}</p>
              </div>
            ) : wantsOAuth ? (
              provider.credentialScope === 'user' ? (
                <PiOAuthButton activeProviderId={provider.providerId} onStatusChange={onCredentialsSaved} />
              ) : (
                <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                  <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
                  <p>{copy.oauthScope}</p>
                </div>
              )
            ) : help?.envVars?.length ? (
              <ProviderEnvEditor
                providerId={provider.providerId}
                envVars={help.envVars}
                credentialScope={provider.credentialScope}
                onSaveComplete={onCredentialsSaved}
              />
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                <p>{copy.noFields}</p>
                <a className="mt-2 inline-flex font-medium text-primary underline-offset-4 hover:underline" href="?tab=integrations">
                  {copy.integrations}
                </a>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
