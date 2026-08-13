'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type McpCapabilityStatus = {
  id: string;
  available: boolean;
  enabled: boolean;
  scopes: string[];
};

type McpServerStatus = {
  desiredEnabled: boolean;
  runtimeEnabled: boolean;
  restartRequired: boolean;
  activationManagedByEnvironment: boolean;
  capabilitiesManagedByEnvironment: boolean;
  endpoint: string | null;
  issuer: string | null;
  protocolVersion: string;
  transport: 'streamable-http';
  authentication: 'oauth-2.1-pkce';
  configurationError: string | null;
  updatedAt: string | null;
  capabilities: McpCapabilityStatus[];
};

type DraftSettings = {
  enabled: boolean;
  tools: string[];
};

function enabledTools(status: McpServerStatus): string[] {
  return status.capabilities
    .filter((capability) => capability.available && capability.enabled)
    .map((capability) => capability.id)
    .sort();
}

function draftsEqual(left: DraftSettings, right: DraftSettings): boolean {
  return left.enabled === right.enabled
    && left.tools.length === right.tools.length
    && left.tools.every((tool, index) => tool === right.tools[index]);
}

export function McpServerSettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('settings.mcpServer');
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [draft, setDraft] = useState<DraftSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<'endpoint' | 'config' | null>(null);

  const applyStatus = useCallback((nextStatus: McpServerStatus) => {
    setStatus(nextStatus);
    setDraft({
      enabled: nextStatus.desiredEnabled,
      tools: enabledTools(nextStatus),
    });
  }, []);

  const loadStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/integrations/mcp-server', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      applyStatus(payload.data as McpServerStatus);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [applyStatus, t]);

  useEffect(() => {
    let active = true;
    void fetch('/api/integrations/mcp-server', {
      credentials: 'include',
      cache: 'no-store',
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.load'));
      }
      if (active) applyStatus(payload.data as McpServerStatus);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [applyStatus, t]);

  const savedDraft: DraftSettings | null = status ? ({
    enabled: status.desiredEnabled,
    tools: enabledTools(status),
  }) : null;
  const isDirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));
  const availableCapabilities = status?.capabilities.filter((capability) => capability.available) ?? [];
  const plannedCapabilityCount = status?.capabilities.filter((capability) => !capability.available).length ?? 0;
  const enabledCapabilityCount = draft?.tools.length ?? 0;
  const publicDomain = (() => {
    if (!status?.endpoint) return null;
    try {
      return new URL(status.endpoint).host;
    } catch {
      return null;
    }
  })();
  const connectionConfig = JSON.stringify({
    mcpServers: {
      canvas: {
        url: status?.endpoint ?? 'https://canvas.example.com/mcp',
      },
    },
  }, null, 2);

  const statusLabel = status?.configurationError
    ? t('status.configurationError')
    : status?.restartRequired
      ? t('status.restartRequired')
      : status?.runtimeEnabled
        ? t('status.active')
        : t('status.inactive');
  const statusVariant = status?.configurationError
    ? 'destructive' as const
    : status?.runtimeEnabled && !status.restartRequired
      ? 'default' as const
      : 'secondary' as const;

  const copyText = async (kind: 'endpoint' | 'config', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
    } catch {
      setError(t('errors.copy'));
    }
  };

  const toggleCapability = (capabilityId: string, enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const tools = enabled
        ? [...new Set([...current.tools, capabilityId])].sort()
        : current.tools.filter((tool) => tool !== capabilityId);
      return { ...current, tools };
    });
    setSuccess(null);
  };

  const save = async () => {
    if (!draft) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch('/api/integrations/mcp-server', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.save'));
      }
      applyStatus(payload.data as McpServerStatus);
      setSuccess(t('saved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading && !status) {
    return (
      <Card className="rounded-xl">
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden rounded-xl">
      <CardHeader className="border-b bg-muted/25">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="mb-2 flex items-center gap-2 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              {t('eyebrow')}
            </p>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Server className="h-5 w-5 text-primary" aria-hidden="true" />
              {t('title')}
            </CardTitle>
            <CardDescription className="mt-2 max-w-3xl leading-6">
              {t('description')}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 shadow-xs">
            <div className="text-right">
              <p className="text-sm font-medium">{t('activation.label')}</p>
              <p className="text-xs text-muted-foreground">{statusLabel}</p>
            </div>
            <Switch
              checked={draft?.enabled ?? false}
              onCheckedChange={(enabled) => {
                setDraft((current) => current ? { ...current, enabled } : current);
                setSuccess(null);
              }}
              disabled={!isAdmin || isSaving || status?.activationManagedByEnvironment}
              aria-label={t('activation.label')}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant}>{statusLabel}</Badge>
          <Badge variant="outline">MCP {status?.protocolVersion}</Badge>
          <Badge variant="outline">OAuth 2.1 + PKCE</Badge>
          <Badge variant="outline">Streamable HTTP</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        {status?.restartRequired ? (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm">
            <p className="font-medium text-foreground">{t('restart.title')}</p>
            <p className="mt-1 leading-5 text-muted-foreground">{t('restart.description')}</p>
          </div>
        ) : null}

        {status?.configurationError ? (
          <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm">
            <p className="font-medium text-destructive">{t('configuration.title')}</p>
            <p className="mt-1 break-words leading-5 text-muted-foreground">{status.configurationError}</p>
          </div>
        ) : null}

        {status?.activationManagedByEnvironment || status?.capabilitiesManagedByEnvironment ? (
          <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm">
            <p className="font-medium">{t('managed.title')}</p>
            <p className="mt-1 leading-5 text-muted-foreground">{t('managed.description')}</p>
          </div>
        ) : null}

        {!isAdmin ? (
          <div className="rounded-lg border bg-muted/35 px-4 py-3 text-sm text-muted-foreground">
            {t('adminOnly')}
          </div>
        ) : null}

        <section aria-labelledby="mcp-public-endpoint-title" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="mcp-public-endpoint-title" className="font-semibold">{t('endpoint.title')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {publicDomain ? t('endpoint.domain', { domain: publicDomain }) : t('endpoint.missing')}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => void loadStatus()} disabled={isLoading}>
              {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t('refresh')}
            </Button>
          </div>
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="min-w-0 flex-1 break-all text-sm font-semibold">
              {status?.endpoint ?? t('endpoint.notConfigured')}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!status?.endpoint}
              onClick={() => status?.endpoint && void copyText('endpoint', status.endpoint)}
            >
              {copied === 'endpoint' ? <Check /> : <Copy />}
              {copied === 'endpoint' ? t('copied') : t('copy')}
            </Button>
          </div>
          {status?.issuer ? (
            <p className="break-all text-xs text-muted-foreground">
              {t('endpoint.issuer')}: <code>{status.issuer}</code>
            </p>
          ) : null}
        </section>

        <section aria-labelledby="mcp-capabilities-title" className="space-y-3 border-t pt-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="mcp-capabilities-title" className="font-semibold">{t('capabilities.title')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('capabilities.description')}</p>
            </div>
            <Badge variant="secondary">{t('capabilities.enabledCount', { count: enabledCapabilityCount })}</Badge>
          </div>
          <div className="divide-y overflow-hidden rounded-lg border">
            {availableCapabilities.map((capability) => (
              <div key={capability.id} className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{t(`capabilities.items.${capability.id}.title`)}</p>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{capability.id}</code>
                  </div>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {t(`capabilities.items.${capability.id}.description`)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {capability.scopes.map((scope) => (
                      <Badge key={scope} variant="outline" className="font-mono font-normal">{scope}</Badge>
                    ))}
                  </div>
                </div>
                <Switch
                  checked={draft?.tools.includes(capability.id) ?? false}
                  onCheckedChange={(enabled) => toggleCapability(capability.id, enabled)}
                  disabled={!isAdmin || isSaving || status?.capabilitiesManagedByEnvironment}
                  aria-label={t(`capabilities.items.${capability.id}.title`)}
                />
              </div>
            ))}
          </div>
          {enabledCapabilityCount === 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">{t('capabilities.noneEnabled')}</p>
          ) : null}
          {plannedCapabilityCount > 0 ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {t('capabilities.planned', { count: plannedCapabilityCount })}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="mcp-connect-title" className="space-y-4 border-t pt-6">
          <div>
            <h3 id="mcp-connect-title" className="font-semibold">{t('connect.title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('connect.description')}</p>
          </div>
          <ol className="grid gap-3 lg:grid-cols-3">
            {(['endpoint', 'transport', 'oauth'] as const).map((step, index) => (
              <li key={step} className="rounded-lg border p-4">
                <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  {index + 1}
                </div>
                <p className="font-medium">{t(`connect.steps.${step}.title`)}</p>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{t(`connect.steps.${step}.description`)}</p>
              </li>
            ))}
          </ol>
          <div className="overflow-hidden rounded-lg border bg-slate-950 text-slate-100 dark:bg-black">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                {t('connect.example')}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-slate-200 hover:bg-white/10 hover:text-white"
                onClick={() => void copyText('config', connectionConfig)}
              >
                {copied === 'config' ? <Check /> : <Copy />}
                {copied === 'config' ? t('copied') : t('copy')}
              </Button>
            </div>
            <pre className="overflow-x-auto p-4 text-xs leading-5"><code>{connectionConfig}</code></pre>
          </div>
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('connect.security')}
          </p>
        </section>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {success ? <p className="text-sm text-primary">{success}</p> : null}

        <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className={cn('text-xs text-muted-foreground', isDirty && 'text-foreground')}>
            {isDirty ? t('unsaved') : t('upToDate')}
          </p>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!isAdmin || !isDirty || isSaving || Boolean(draft?.enabled && !status?.endpoint)}
          >
            {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
            {isSaving ? t('saving') : t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
