'use client';

import { useEffect, useState } from 'react';
import { Cloud, Loader2, RefreshCw } from 'lucide-react';

import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Source = 'managed' | 'local' | 'disabled' | 'unknown';
type Service = 'ai' | 'composio' | 'search' | 'gemini' | 'openai' | 'kie';
type Access = { source: Source; attention?: boolean; searchProvider?: 'brave' | 'ollama' };
type Snapshot = { key: string; completed: number; services: Partial<Record<Service, Access>> };

const services: Service[] = ['ai', 'composio', 'search', 'gemini', 'openai', 'kie'];
const copy = {
  de: {
    title: 'Über Canvas verwaltete Zugänge',
    description: 'Für Managed-Dienste verwaltet Canvas die API-Schlüssel. Deine App nutzt den Zugang über die Control Plane, ohne diese Schlüssel lokal zu speichern.',
    managedSummary: 'Über die Control Plane:',
    noManaged: 'Für die geprüften Dienste ist derzeit kein Zugang über die Control Plane ausgewählt.',
    checking: 'Zugriffsquellen werden geprüft …',
    partial: 'Einige Zugriffsquellen konnten nicht bestätigt werden. Lade die Übersicht erneut, um sie zu prüfen.',
    details: 'Dienste und Zugriffsquellen',
    context: 'Die Übersicht gilt für deine aktuellen Dienste und den aktiven Workspace. Der Speicherbereich im Formular darunter verändert diese Anzeige nicht.',
    reload: 'Zugriffsquellen neu laden',
    managed: 'Control Plane',
    local: 'Eigene Zugangsdaten',
    disabled: 'Nicht eingerichtet',
    unknown: 'Nicht bestätigt',
    attention: 'Zugriff prüfen',
    ai: 'KI · aktuelle Auswahl',
    composio: 'Composio',
    search: 'Websuche',
    gemini: 'Studio · Google Gemini',
    openai: 'Studio · OpenAI',
    kie: 'Studio · KIE.ai',
  },
  en: {
    title: 'Access managed by Canvas',
    description: 'Canvas manages the API keys for managed services. Your app uses access through Control Plane without storing these keys locally.',
    managedSummary: 'Through Control Plane:',
    noManaged: 'The checked services currently have no access through Control Plane selected.',
    checking: 'Checking access sources …',
    partial: 'Some access sources could not be confirmed. Reload the overview to check them.',
    details: 'Services and access sources',
    context: 'This overview applies to your current services and active workspace. Selecting a storage scope in the form below does not change it.',
    reload: 'Reload access sources',
    managed: 'Control Plane',
    local: 'Own credentials',
    disabled: 'Not configured',
    unknown: 'Unconfirmed',
    attention: 'Check access',
    ai: 'AI · current selection',
    composio: 'Composio',
    search: 'Web search',
    gemini: 'Studio · Google Gemini',
    openai: 'Studio · OpenAI',
    kie: 'Studio · KIE.ai',
  },
} as const;

function modeSource(mode: unknown): Source {
  return mode === 'managed' || mode === 'local' || mode === 'disabled' ? mode : 'unknown';
}

async function readStatus(url: string, signal: AbortSignal, headers?: HeadersInit) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal, headers });
  if (!response.ok) throw new Error('Status unavailable');
  return response.json();
}

export function ManagedSecretsInfo({ language }: { language: 'de' | 'en' }) {
  const t = copy[language];
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const hydrateWorkspaces = useWorkspaceStore(state => state.hydrateWorkspaces);
  const workspaceId = activeWorkspace?.id || '';
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const key = JSON.stringify([workspaceId, refresh]);
  const current = snapshot?.key === key ? snapshot : null;
  const loading = !current || current.completed < 4;

  useEffect(() => { void hydrateWorkspaces(); }, [hydrateWorkspaces]);
  useEffect(() => {
    const onSaved = () => setRefresh(value => value + 1);
    window.addEventListener('canvas_secrets_updated', onSaved);
    return () => window.removeEventListener('canvas_secrets_updated', onSaved);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    const record = (result: Partial<Record<Service, Access>>) => {
      if (disposed) return;
      setSnapshot(previous => ({
        key,
        completed: (previous?.key === key ? previous.completed : 0) + 1,
        services: { ...(previous?.key === key ? previous.services : {}), ...result },
      }));
    };
    const check = async (ids: Service[], load: () => Promise<Partial<Record<Service, Access>>>) => {
      try { record(await load()); }
      catch { record(Object.fromEntries(ids.map(id => [id, { source: 'unknown' }]))); }
    };
    void check(['composio'], async () => {
      if (!workspaceId) return { composio: { source: 'unknown' } };
      const status = await readStatus('/api/composio/status', controller.signal, { [WORKSPACE_ID_HEADER]: workspaceId });
      return { composio: { source: modeSource(status?.mode), attention: status?.configured === false || status?.apiKeyValid === false || status?.providerHealthy === false || status?.apiKeyState === 'unknown' } };
    });
    void check(['search'], async () => {
      const status = await readStatus('/api/integrations/search/status', controller.signal);
      if (status?.success !== true) return { search: { source: 'unknown' } };
      return { search: { source: modeSource(status.data?.mode), searchProvider: status.data?.provider === 'ollama' ? 'ollama' : status.data?.provider === 'brave' ? 'brave' : undefined } };
    });
    void check(['gemini', 'openai', 'kie'], async () => {
      const status = await readStatus('/api/studio/config', controller.signal);
      return Object.fromEntries((['gemini', 'openai', 'kie'] as const).map(id => {
        const ownKey = status?.config?.localApiKeys?.[id];
        const managed = status?.config?.managedMediaAvailable;
        const source: Source = status?.success !== true || typeof ownKey !== 'boolean' || typeof managed !== 'boolean'
          ? 'unknown' : ownKey ? 'local' : managed ? 'managed' : 'unknown';
        return [id, { source }];
      }));
    });
    void check(['ai'], async () => {
      if (!workspaceId) return { ai: { source: 'unknown' } };
      const status = await readStatus(`/api/agent-runtime/effective?${new URLSearchParams({ workspaceId })}`, controller.signal);
      const scope = status?.data?.effectiveSelection?.credentialScope;
      const source: Source = status?.success !== true ? 'unknown' : scope === 'managed' ? 'managed' : ['system', 'organization', 'user'].includes(scope) ? 'local' : 'unknown';
      return { ai: { source, attention: status?.data?.valid === false } };
    });
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [key, workspaceId]);

  const serviceName = (id: Service) => id === 'search' && current?.services.search?.searchProvider
    ? `${t.search} · ${current.services.search.searchProvider === 'brave' ? 'Brave' : 'Ollama'}` : t[id];
  const managed = services.filter(id => current?.services[id]?.source === 'managed');
  const unconfirmed = services.some(id => current?.services[id]?.source === 'unknown');
  const attention = services.some(id => current?.services[id]?.attention);

  return (
    <Card data-testid="managed-secrets-info" className="gap-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base"><Cloud className="h-4 w-4 shrink-0" aria-hidden="true" />{t.title}</CardTitle>
            <CardDescription className="mt-2">{t.description}</CardDescription>
          </div>
          <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t.reload} disabled={loading} onClick={() => setRefresh(value => value + 1)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div role="status" aria-live="polite">
          {loading ? <p className="text-muted-foreground">{t.checking}</p> : managed.length ? <p><span className="font-medium">{t.managedSummary}</span> {managed.map(serviceName).join(' · ')}</p> : <p className="text-muted-foreground">{unconfirmed ? t.partial : t.noManaged}</p>}
          {!loading && managed.length > 0 && unconfirmed && <p className="mt-2 text-muted-foreground">{t.partial}</p>}
          {!loading && attention && <p className="mt-2 text-amber-700 dark:text-amber-400">{t.attention}</p>}
        </div>
        <details data-testid="managed-access-details" className="rounded-md border">
          <summary className="cursor-pointer px-3 py-3 font-medium focus-visible:outline-ring">{t.details}</summary>
          <div className="space-y-3 px-3 pb-3">
            <p className="text-xs text-muted-foreground">{t.context}</p>
            <dl className="divide-y">
              {services.map(id => {
                const access = current?.services[id];
                return <div key={id} data-testid={`managed-access-${id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <dt className="min-w-0 break-words">{serviceName(id)}</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{access ? t[access.source] : t.checking}</Badge>
                    {access?.attention && <span className="text-xs text-amber-700 dark:text-amber-400">{t.attention}</span>}
                  </dd>
                </div>;
              })}
            </dl>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
