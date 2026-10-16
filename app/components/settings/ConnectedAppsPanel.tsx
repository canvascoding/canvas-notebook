'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, Eye, EyeOff, Loader2, Plug, RefreshCw } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { authClient } from '@/app/lib/auth-client';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SettingsAccordionCard } from './SettingsAccordionCard';
import { ComposioProfileSwitcher, type ComposioEffectiveProfile } from './ComposioProfileSwitcher';
import { patchScopedIntegrationEnv } from './mcp-setup-client';

type ComposioStatus = {
  configured: boolean;
  apiKeyValid: boolean;
  apiKeyState?: 'missing' | 'valid' | 'invalid_or_insufficient_scope' | 'unknown';
  providerHealthy?: boolean;
  mode: 'local' | 'managed' | 'disabled';
  localConfigured?: boolean;
  managedAvailable?: boolean;
  effectiveProfile?: ComposioEffectiveProfile;
  workspace?: { id: string; name: string | null; type: string };
};
type ConnectedAppsPanelProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isAdmin?: boolean;
};

export function ConnectedAppsPanel(props: ConnectedAppsPanelProps) {
  const { data: session, isPending, error } = authClient.useSession();
  const workspace = useWorkspaceStore(selectActiveWorkspace);
  const hydrate = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const hydrating = useWorkspaceStore((state) => !state.initialized || state.isLoading);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  return (
    <ConnectedAppsSession
      key={JSON.stringify([session?.user.id, session?.session.id, workspace?.id])}
      {...props}
      actorId={session?.user.id ?? null}
      sessionId={session?.session.id ?? null}
      workspaceId={workspace?.id ?? null}
      workspaceName={workspace?.name ?? null}
      enabled={Boolean(session && workspace && !isPending && !error)}
      contextPending={isPending || (hydrating && !workspace)}
    />
  );
}

function ConnectedAppsSession({
  isOpen,
  onOpenChange,
  isAdmin = false,
  actorId,
  sessionId,
  workspaceId,
  workspaceName,
  enabled,
  contextPending,
}: ConnectedAppsPanelProps & {
  actorId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  enabled: boolean;
  contextPending: boolean;
}) {
  const t = useTranslations('settings.connectedApps');
  const [status, setStatus] = useState<ComposioStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const isCurrent = useCallback(() => {
    const current = authClient.$store.atoms.session.get();
    const active = selectActiveWorkspace(useWorkspaceStore.getState());
    return (
      alive.current &&
      enabled &&
      !current.isPending &&
      !current.error &&
      current.data?.user.id === actorId &&
      current.data?.session.id === sessionId &&
      (active?.id ?? null) === workspaceId
    );
  }, [actorId, enabled, sessionId, workspaceId]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      readController.current?.abort();
      writeController.current?.abort();
    };
  }, []);
  const loadStatus = useCallback(async () => {
    if (!isCurrent()) {
      return;
    }
    readController.current?.abort();
    const controller = new AbortController();
    const current = ++generation.current;
    readController.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/composio/status', {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: workspaceId ? { [WORKSPACE_ID_HEADER]: workspaceId } : {},
      });
      const data = (await response.json()) as ComposioStatus;
      if (!isCurrent() || controller.signal.aborted || current !== generation.current) {
        return;
      }
      if (
        !response.ok ||
        typeof data.configured !== 'boolean' ||
        !['local', 'managed', 'disabled'].includes(data.mode) ||
        (data.workspace && data.workspace.id !== workspaceId) ||
        (data.effectiveProfile && data.effectiveProfile.workspaceId !== workspaceId)
      ) {
        throw new Error('status_unavailable');
      }
      setStatus(data);
    } catch {
      if (isCurrent() && !controller.signal.aborted && current === generation.current) {
        setStatus(null);
        setError(t('loadError'));
      }
    } finally {
      if (isCurrent() && current === generation.current) {
        setLoading(false);
      }
    }
  }, [isCurrent, t, workspaceId]);
  useEffect(() => {
    queueMicrotask(() => {
      if (!alive.current) {
        return;
      }
      if (enabled) {
        void loadStatus();
      } else {
        readController.current?.abort();
        setStatus(null);
        setLoading(contextPending);
      }
    });
  }, [contextPending, enabled, loadStatus]);
  useEffect(() => {
    const update = () => {
      if (isCurrent() && !writeController.current) {
        void loadStatus();
      }
    };
    window.addEventListener('canvas_secrets_updated', update);
    return () => window.removeEventListener('canvas_secrets_updated', update);
  }, [isCurrent, loadStatus]);
  const saveApiKey = useCallback(async () => {
    const value = apiKeyDraft.trim();
    if (!value || !isAdmin || !isCurrent() || writeController.current) {
      return;
    }
    const controller = new AbortController();
    writeController.current = controller;
    setApiKeySaving(true);
    setApiKeySaved(false);
    setError(null);
    try {
      await patchScopedIntegrationEnv([{ key: 'COMPOSIO_API_KEY', value }], t('saveError'), {
        secretScope: 'system',
        workspaceId,
        signal: controller.signal,
        isCurrent,
      });
      if (!isCurrent()) {
        return;
      }
      setApiKeyDraft('');
      setApiKeyVisible(false);
      setApiKeySaved(true);
      await loadStatus();
    } catch {
      if (isCurrent() && !controller.signal.aborted) {
        setError(t('saveError'));
      }
    } finally {
      if (writeController.current === controller) {
        writeController.current = null;
      }
      if (isCurrent()) {
        setApiKeySaving(false);
      }
    }
  }, [apiKeyDraft, isAdmin, isCurrent, loadStatus, t, workspaceId]);
  const missingKey = Boolean(
    status &&
      status.mode !== 'managed' &&
      (status.apiKeyState === 'missing' || status.mode === 'disabled'),
  );
  const invalidKey = status?.apiKeyState === 'invalid_or_insufficient_scope';
  const degraded = Boolean(
    status?.configured &&
      !missingKey &&
      !invalidKey &&
      (status.providerHealthy === false || status.apiKeyState === 'unknown'),
  );
  const summary = loading
    ? t('apiKeyChecking')
    : !status
      ? t('statusUnknown')
      : degraded
        ? t('providerUnavailable')
        : missingKey
          ? t('notConfiguredShort')
          : invalidKey
            ? t('apiKeyInvalid')
            : status.mode === 'managed'
              ? t('modeManaged')
              : t('configuredShort');
  const catalogParams = new URLSearchParams({
    view: 'browse',
    kind: 'integration',
    ...(workspaceId ? { workspaceId } : {}),
  });
  const catalog = `/plugins?${catalogParams}`;
  return (
    <SettingsAccordionCard
      title={t('title')}
      description={t('description')}
      icon={Plug}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={[
        summary,
        ...(status?.effectiveProfile?.name
          ? [t('profiles.summaryProfile', { name: status.effectiveProfile.name })]
          : []),
      ]}
      contentClassName="space-y-5"
    >
      <div className="rounded-lg border p-4">
        <p className="mb-3 text-sm text-muted-foreground">{t('catalogDescription')}</p>
        <Button asChild>
          <Link href={catalog} data-testid="composio-open-catalog">
            {t('openCatalog')}
          </Link>
        </Button>
      </div>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('apiKeyChecking')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{summary}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadStatus()}
            disabled={!enabled || apiKeySaving}
            data-testid="composio-status-reload"
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {t('refresh')}
          </Button>
        </div>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!loading && !status ? (
        <p className="text-sm text-muted-foreground">{t('statusUnknown')}</p>
      ) : null}
      {degraded ? <p className="text-sm text-amber-700">{t('providerUnavailable')}</p> : null}
      {status ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge>
              {t(
                status.mode === 'managed'
                  ? 'modeManaged'
                  : status.mode === 'local'
                    ? 'modeLocal'
                    : 'modeMissing',
              )}
            </Badge>
            {status.localConfigured ? (
              <Badge variant="outline">{t('localConfigured')}</Badge>
            ) : null}
            {status.managedAvailable ? (
              <Badge variant="outline">{t('managedAvailable')}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {t(status.mode === 'managed' ? 'managedDescription' : 'localDescription')}
          </p>
        </>
      ) : null}
      {workspaceId && status?.effectiveProfile && status.workspace?.id === workspaceId ? (
        <ComposioProfileSwitcher
          workspaceId={workspaceId}
          workspaceName={status.workspace.name || workspaceName || t('profiles.unknownWorkspace')}
          initialEffectiveProfile={status.effectiveProfile}
          isCurrent={isCurrent}
          onProfileChanged={loadStatus}
        />
      ) : null}
      {isAdmin ? (
        <details
          open={missingKey || invalidKey || apiKeySaved}
          className="rounded-lg border p-4"
          data-testid="composio-key-configuration"
        >
          <summary className="cursor-pointer text-sm font-medium">Composio API Key</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              {t(invalidKey ? 'apiKeyInvalid' : 'localDescription')}
            </p>
            <Label htmlFor="composio-api-key">Composio API Key</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input
                  id="composio-api-key"
                  type={apiKeyVisible ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={apiKeyDraft}
                  placeholder="composio_..."
                  disabled={!enabled || apiKeySaving}
                  className="pr-11"
                  onChange={(event) => {
                    setApiKeyDraft(event.target.value);
                    setApiKeySaved(false);
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label={t(apiKeyVisible ? 'hideSecret' : 'showSecret')}
                  disabled={!enabled || apiKeySaving}
                  onClick={() => setApiKeyVisible((value) => !value)}
                >
                  {apiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <Button
                onClick={() => void saveApiKey()}
                disabled={!enabled || apiKeySaving || !apiKeyDraft.trim()}
                data-testid="composio-save-api-key"
              >
                {apiKeySaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {t('saveApiKey')}
              </Button>
            </div>
            {apiKeySaved ? (
              <p className="text-sm text-primary" data-testid="composio-api-key-saved">
                {t('apiKeySaved')}
              </p>
            ) : null}
            <a
              href="https://composio.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            >
              {t('getApiKey')}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </details>
      ) : missingKey || invalidKey ? (
        <p className="text-sm text-muted-foreground">{t('apiKeyAdminDescription')}</p>
      ) : null}
      <Link
        href="/settings?tab=secrets"
        className="text-sm text-primary hover:underline"
        data-testid="composio-open-secrets"
      >
        {t('openSecrets')}
      </Link>
    </SettingsAccordionCard>
  );
}
