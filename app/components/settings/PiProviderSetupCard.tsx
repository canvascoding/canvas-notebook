'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  HelpCircle,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type {
  OllamaMode,
  PiProviderConfig,
  PiRuntimeConfig,
  PiThinkingLevel,
} from '@/app/lib/pi/config';
import {
  getProviderHelp,
  requiresCliAuth,
  supportsBothAuthMethods,
  type ProviderHelpInfo,
} from '@/app/lib/pi/provider-help';
import { ProviderEnvEditor } from './ProviderEnvEditor';
import { PiOAuthButton } from './PiOAuthButton';

type DiscoveryMetadata = Record<string, { models: { id: string; name: string; supportsVision?: boolean }[] }>;

type AgentConfigReadiness = {
  activeProviderId: string;
  activeProviderReady: boolean;
  pi?: {
    activeProvider: string;
    model: string;
    ready: boolean;
    authSet: boolean;
    issues: string[];
  };
};

type AgentConfigResponse = {
  piConfig: PiRuntimeConfig;
  engine: 'legacy' | 'pi';
  readiness: AgentConfigReadiness;
  discovery: DiscoveryMetadata;
};

type ProviderStatus = {
  isReady: boolean;
  hasApiKey: boolean;
  hasOAuth: boolean;
  requiresKey: boolean;
  requiresOAuth: boolean;
  issues: string[];
};

type PiProviderSetupCardProps = {
  title?: string;
  description?: string;
  saveButtonLabel?: string;
  saveSuccessMessage?: string;
  onSaved?: (payload: { piConfig: PiRuntimeConfig; readiness: AgentConfigReadiness }) => Promise<void> | void;
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: T;
  };

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return (payload.data as T) ?? (payload as unknown as T);
}

function requiresOAuthAuth(providerId: string): boolean {
  return requiresCliAuth(providerId);
}

export function PiProviderSetupCard({
  title = 'Agent Runtime Settings',
  description = 'Konfiguration der PI-basierten Agent-Engine.',
  saveButtonLabel = 'Einstellungen speichern',
  saveSuccessMessage = 'Agent-Konfiguration gespeichert.',
  onSaved,
}: PiProviderSetupCardProps) {
  const [piConfigDraft, setPiConfigDraft] = useState<PiRuntimeConfig | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryMetadata>({});
  const [readiness, setReadiness] = useState<AgentConfigReadiness | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isOllamaConfigOpen, setIsOllamaConfigOpen] = useState(false);
  const [selectedProviderStatus, setSelectedProviderStatus] = useState<ProviderStatus | null>(null);
  const [selectedProviderLoading, setSelectedProviderLoading] = useState(false);

  const loadProviderStatus = useCallback(async (providerId: string) => {
    setSelectedProviderLoading(true);
    try {
      const response = await fetch(`/api/agents/provider-status?providerId=${encodeURIComponent(providerId)}`, {
        credentials: 'include',
      });
      const data = await response.json();

      if (data.success) {
        setSelectedProviderStatus({
          isReady: data.isReady,
          hasApiKey: data.hasApiKey,
          hasOAuth: data.hasOAuth,
          requiresKey: data.requiresKey,
          requiresOAuth: data.requiresOAuth,
          issues: data.issues,
        });
        return;
      }

      setSelectedProviderStatus(null);
    } catch (error) {
      console.error('Failed to load provider status:', error);
      setSelectedProviderStatus(null);
    } finally {
      setSelectedProviderLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);

    try {
      const payload = await fetchJson<AgentConfigResponse>('/api/agents/config');
      setPiConfigDraft(deepClone(payload.piConfig));
      setDiscovery(payload.discovery || {});
      setReadiness(payload.readiness);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to load agent config.');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!piConfigDraft?.activeProvider) {
      return;
    }

    void loadProviderStatus(piConfigDraft.activeProvider);
  }, [piConfigDraft?.activeProvider, loadProviderStatus]);

  useEffect(() => {
    setIsHelpOpen(false);
    setIsOllamaConfigOpen(false);
    setConfigSuccess(null);
  }, [piConfigDraft?.activeProvider]);

  const setPiProviderField = <K extends keyof PiProviderConfig>(
    providerId: string,
    field: K,
    value: PiProviderConfig[K],
  ) => {
    setPiConfigDraft((current) => {
      if (!current) {
        return current;
      }

      const next = deepClone(current);
      if (!next.providers[providerId]) {
        next.providers[providerId] = {
          id: providerId,
          model: '',
          thinking: 'none',
          enabledTools: [],
        };
      }

      next.providers[providerId][field] = value;
      return next;
    });
  };

  const setActivePiProvider = (providerId: string) => {
    setPiConfigDraft((current) => {
      if (!current) {
        return current;
      }

      const next = deepClone(current);
      next.activeProvider = providerId;

      if (!next.providers[providerId]) {
        next.providers[providerId] = {
          id: providerId,
          model: '',
          thinking: 'none',
          enabledTools: ['filesystem', 'terminal'],
        };
      }

      return next;
    });
  };

  const saveConfig = async () => {
    if (!piConfigDraft) {
      return;
    }

    const activeProviderConfig = piConfigDraft.providers[piConfigDraft.activeProvider];
    if (!activeProviderConfig?.model?.trim()) {
      setConfigError(`Bitte wähle ein Modell für "${piConfigDraft.activeProvider}".`);
      setConfigSuccess(null);
      return;
    }

    if (piConfigDraft.activeProvider === 'ollama') {
      if (activeProviderConfig.ollamaModelSource === 'custom' && !activeProviderConfig.ollamaCustomModel?.trim()) {
        setConfigError('Bitte trage einen Namen für das Custom Ollama Model ein.');
        setConfigSuccess(null);
        return;
      }

      if ((activeProviderConfig.ollamaMode || 'local') === 'cloud' && !activeProviderConfig.ollamaHost?.trim()) {
        setConfigError('Bitte trage eine Remote Server URL für Ollama ein.');
        setConfigSuccess(null);
        return;
      }
    }

    setConfigSaving(true);
    setConfigError(null);
    setConfigSuccess(null);

    try {
      const payload = await fetchJson<AgentConfigResponse>('/api/agents/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          piConfig: piConfigDraft,
        }),
      });

      setPiConfigDraft(deepClone(payload.piConfig));
      setReadiness(payload.readiness);
      setConfigSuccess(saveSuccessMessage);
      await onSaved?.({ piConfig: payload.piConfig, readiness: payload.readiness });
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to save agent config.');
    } finally {
      setConfigSaving(false);
    }
  };

  const activateProvider = useCallback(async (providerId: string) => {
    if (!piConfigDraft || piConfigDraft.activeProvider === providerId) {
      return;
    }

    const payload = await fetchJson<AgentConfigResponse>('/api/agents/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        piConfig: {
          ...piConfigDraft,
          activeProvider: providerId,
        },
      }),
    });

    setPiConfigDraft(deepClone(payload.piConfig));
    setReadiness(payload.readiness);
  }, [piConfigDraft]);

  if (configLoading && !piConfigDraft) {
    return (
      <div className="flex items-center p-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Lade Agent-Konfiguration...
      </div>
    );
  }

  if (!piConfigDraft) {
    return (
      <div className="rounded border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {configError || 'Agent-Konfiguration konnte nicht geladen werden.'}
      </div>
    );
  }

  const activeProviderConfig = piConfigDraft.providers[piConfigDraft.activeProvider];

  return (
    <Card className="border-primary shadow-sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-semibold">Aktiver Provider</span>
            <select
              data-testid="provider-select"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={piConfigDraft.activeProvider}
              onChange={(event) => setActivePiProvider(event.target.value)}
              disabled={configSaving}
            >
              {(Object.keys(discovery).length > 0
                ? Object.keys(discovery).sort()
                : Object.keys(piConfigDraft.providers)
              ).map((providerId) => (
                <option key={providerId} value={providerId}>
                  {providerId}
                </option>
              ))}
            </select>
          </label>

          {activeProviderConfig && (
            <div className="space-y-2 text-sm">
              <span className="font-semibold">Modell für {piConfigDraft.activeProvider}</span>

              {piConfigDraft.activeProvider === 'ollama' ? (
                <>
                  <select
                    data-testid="model-select"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    value={
                      piConfigDraft.providers.ollama?.ollamaModelSource === 'custom'
                        ? 'custom'
                        : activeProviderConfig.model
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === 'custom') {
                        setPiProviderField('ollama', 'ollamaModelSource', 'custom');
                        if (!piConfigDraft.providers.ollama?.ollamaCustomModel) {
                          setPiProviderField('ollama', 'ollamaCustomModel', piConfigDraft.providers.ollama?.model || '');
                        }
                        return;
                      }

                      setPiProviderField('ollama', 'ollamaModelSource', 'predefined');
                      setPiProviderField('ollama', 'model', value);
                      setPiProviderField('ollama', 'ollamaCustomModel', undefined);
                    }}
                    disabled={configSaving}
                  >
                    <option value="">-- Modell wählen --</option>
                    {(discovery[piConfigDraft.activeProvider]?.models || []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.id} {model.supportsVision ? '👁️' : ''}
                      </option>
                    ))}
                    <option value="custom">➕ Custom Model...</option>
                  </select>

                  {piConfigDraft.providers.ollama?.ollamaModelSource === 'custom' && (
                    <div className="mt-3 space-y-2">
                      <Input
                        data-testid="ollama-custom-model-input"
                        placeholder="z.B. mein-custom-model:latest"
                        value={piConfigDraft.providers.ollama?.ollamaCustomModel || ''}
                        onChange={(event) => {
                          const customModel = event.target.value;
                          setPiProviderField('ollama', 'ollamaCustomModel', customModel);
                          setPiProviderField('ollama', 'model', customModel);
                        }}
                        disabled={configSaving}
                      />
                      <p className="text-xs text-muted-foreground">
                        Gib den Namen deines Custom Models ein. Beispiel: mein-modell:latest oder llama3.1:8b
                      </p>
                    </div>
                  )}

                  <p className="mt-1 text-xs text-muted-foreground">
                    👁️ = Vision-fähig (unterstützt Bilder) | Wähle &quot;Custom Model&quot;, um ein nicht gelistetes Modell zu verwenden
                  </p>
                </>
              ) : (
                <>
                  <select
                    data-testid="model-select"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    value={activeProviderConfig.model}
                    onChange={(event) => setPiProviderField(piConfigDraft.activeProvider, 'model', event.target.value)}
                    disabled={configSaving}
                  >
                    <option value="">-- Modell wählen --</option>
                    {(discovery[piConfigDraft.activeProvider]?.models || []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.id} {model.supportsVision ? '👁️' : ''}
                      </option>
                    ))}
                    {!discovery[piConfigDraft.activeProvider] && (
                      <option value={activeProviderConfig.model}>
                        {activeProviderConfig.model} (Manuell)
                      </option>
                    )}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">👁️ = Vision-fähig (unterstützt Bilder)</p>
                </>
              )}
            </div>
          )}
        </div>

        {piConfigDraft.activeProvider === 'ollama' && (
          <Collapsible open={isOllamaConfigOpen} onOpenChange={setIsOllamaConfigOpen}>
            <CollapsibleTrigger
              data-testid="ollama-config-toggle"
              className="flex w-full items-center justify-between rounded border border-border bg-muted/30 p-3 text-sm transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">Ollama Konfiguration</span>
                <span className="rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">
                  {(piConfigDraft.providers.ollama?.ollamaMode || 'local') === 'cloud' ? 'Remote Server' : 'Standard (Lokal)'}
                </span>
              </div>
              {isOllamaConfigOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-4 rounded-b border-x border-b border-border bg-muted/20 p-4 text-sm">
                <div className="space-y-2">
                  <span className="font-semibold">Ollama Server</span>
                  <select
                    data-testid="ollama-server-select"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    value={piConfigDraft.providers.ollama?.ollamaMode || 'local'}
                    onChange={(event) => {
                      const mode = event.target.value as OllamaMode;
                      setPiProviderField('ollama', 'ollamaMode', mode);
                      if (mode === 'local') {
                        setPiProviderField('ollama', 'ollamaHost', undefined);
                      }
                    }}
                    disabled={configSaving}
                  >
                    <option value="local">Standard (Lokal) - localhost:11434</option>
                    <option value="cloud">Remote Server - Eigene URL</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {piConfigDraft.providers.ollama?.ollamaMode === 'cloud'
                      ? 'Remote Server: Verbindung zu einem externen Ollama Server im Netzwerk oder in der Cloud.'
                      : 'Standard (Lokal): Ollama läuft auf deinem Computer unter localhost:11434.'}
                  </p>
                </div>

                {piConfigDraft.providers.ollama?.ollamaMode === 'cloud' && (
                  <div className="space-y-2">
                    <span className="font-semibold">Remote Server URL</span>
                    <Input
                      data-testid="ollama-remote-url"
                      placeholder="http://192.168.1.100:11434 oder https://ollama.example.com"
                      value={piConfigDraft.providers.ollama?.ollamaHost || ''}
                      onChange={(event) => setPiProviderField('ollama', 'ollamaHost', event.target.value)}
                      disabled={configSaving}
                    />
                    <p className="text-xs text-muted-foreground">
                      Gib die URL deines Ollama Servers ein. Beispiele: http://192.168.1.100:11434 oder https://ollama.dein-server.de
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-2 rounded-md border border-border bg-background p-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium">Ollama im Terminal konfigurieren</p>
                    <p className="text-xs text-muted-foreground">
                      Öffne das Terminal, um Modelle zu pullen und den Server zu starten.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open('/terminal', '_blank')}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Terminal öffnen
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-semibold">Thinking Level</span>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={activeProviderConfig?.thinking || 'none'}
              onChange={(event) => setPiProviderField(piConfigDraft.activeProvider, 'thinking', event.target.value as PiThinkingLevel)}
              disabled={configSaving}
            >
              <option value="none">None (Standard)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High / Reasoning</option>
            </select>
          </label>

          <div className="rounded border border-border bg-muted/40 p-3 text-xs">
            <p className="mb-1 font-semibold">Provider-Status</p>
            {selectedProviderLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="text-muted-foreground">Prüfe...</span>
              </div>
            ) : (
              <>
                <p className={selectedProviderStatus?.isReady ? 'text-primary' : 'font-bold text-destructive'}>
                  {selectedProviderStatus?.isReady ? 'Bereit (Ready)' : 'Nicht bereit (Not ready)'}
                </p>
                {selectedProviderStatus?.issues?.[0] && (
                  <p className="mt-1 text-muted-foreground">{selectedProviderStatus.issues[0]}</p>
                )}
              </>
            )}
          </div>
        </div>

        {piConfigDraft.activeProvider && supportsBothAuthMethods(piConfigDraft.activeProvider) && (
          <div className="space-y-3 rounded border border-border bg-card p-4">
            <h4 className="text-sm font-semibold">Authentication Method</h4>
            <p className="text-xs text-muted-foreground">
              Choose how you want to authenticate with this provider:
            </p>
            <div className="flex gap-2">
              <Button
                variant={activeProviderConfig?.authMethod === 'api-key' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPiProviderField(piConfigDraft.activeProvider, 'authMethod', 'api-key')}
                className="flex-1"
              >
                API Key
              </Button>
              <Button
                variant={activeProviderConfig?.authMethod === 'oauth' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPiProviderField(piConfigDraft.activeProvider, 'authMethod', 'oauth')}
                className="flex-1"
              >
                OAuth / CLI
              </Button>
            </div>

            {activeProviderConfig?.authMethod === 'api-key' && (
              <div className="mt-3 rounded bg-muted/50 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium">API Key Setup:</p>
                <p>Lege den API-Key im Konfigurationsbereich unten an und speichere ihn dort.</p>
              </div>
            )}

            {activeProviderConfig?.authMethod === 'oauth' && (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">OAuth Status</span>
                  {selectedProviderStatus?.hasOAuth ? (
                    <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                      <Check className="h-3 w-3" />
                      Connected
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                      Not connected
                    </span>
                  )}
                </div>
                <PiOAuthButton onStatusChange={() => void loadProviderStatus(piConfigDraft.activeProvider)} />
              </div>
            )}
          </div>
        )}

        {piConfigDraft.activeProvider &&
          requiresOAuthAuth(piConfigDraft.activeProvider) &&
          !supportsBothAuthMethods(piConfigDraft.activeProvider) && (
            <div className="space-y-3 rounded border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">OAuth Authentication</h4>
                {selectedProviderStatus?.hasOAuth ? (
                  <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                    <Check className="h-3 w-3" />
                    Connected
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    Not connected
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Connect your account to use this provider. Your credentials are stored securely.
              </p>
              <PiOAuthButton onStatusChange={() => void loadProviderStatus(piConfigDraft.activeProvider)} />
            </div>
          )}

        <div className="rounded border border-border bg-muted/20 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-tight text-muted-foreground">System Info</p>
          <p className="text-xs text-muted-foreground">
            Die Engine nutzt API-Keys aus den Integrations-Einstellungen. Modell-Discovery erfolgt über die PI-Registry.
          </p>
        </div>

        <ProviderHelpSection
          providerId={piConfigDraft.activeProvider}
          isProviderReady={readiness?.pi?.ready || false}
          isOpen={isHelpOpen}
          onOpenChange={setIsHelpOpen}
          onProviderActivate={activateProvider}
          onProviderSaved={async () => {
            await loadConfig();
            await loadProviderStatus(piConfigDraft.activeProvider);
          }}
        />

        {configError && <p className="text-sm text-destructive">{configError}</p>}
        {configSuccess && <p className="text-sm text-primary">{configSuccess}</p>}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button onClick={() => void saveConfig()} disabled={configSaving}>
            {configSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {saveButtonLabel}
          </Button>
          <Button variant="outline" onClick={() => void loadConfig()} disabled={configLoading || configSaving}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Neu laden
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type ProviderHelpSectionProps = {
  providerId: string;
  isProviderReady: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onProviderActivate: (providerId: string) => Promise<void>;
  onProviderSaved: () => Promise<void>;
};

function ProviderHelpSection({
  providerId,
  isProviderReady,
  isOpen,
  onOpenChange,
  onProviderActivate,
  onProviderSaved,
}: ProviderHelpSectionProps) {
  const help = getProviderHelp(providerId);

  if (!help) {
    return null;
  }

  const getCategoryIcon = (category: ProviderHelpInfo['category']) => {
    switch (category) {
      case 'api-key':
        return '🔑';
      case 'oauth-cli':
        return '🔐';
      case 'adc':
        return '☁️';
      case 'aws':
        return '⚡';
      case 'azure':
        return '🔷';
      case 'ollama':
        return '🖥️';
      default:
        return '❓';
    }
  };

  const getCategoryLabel = (category: ProviderHelpInfo['category']) => {
    switch (category) {
      case 'api-key':
        return 'API Key';
      case 'oauth-cli':
        return 'OAuth/CLI Login';
      case 'adc':
        return 'Application Default Credentials';
      case 'aws':
        return 'AWS Credentials';
      case 'azure':
        return 'Azure Credentials';
      case 'ollama':
        return 'Local Installation';
      default:
        return 'Unknown';
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded border border-border bg-muted/30 p-3 text-sm transition-colors hover:bg-muted/50">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">
            {getCategoryIcon(help.category)} {help.title} - Konfiguration
          </span>
          {isProviderReady && (
            <span className="ml-2 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              Konfiguriert
            </span>
          )}
        </div>
        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 rounded-b border-x border-b border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-1 text-xs font-medium">
              {getCategoryLabel(help.category)}
            </span>
          </div>

          <p className="text-sm text-muted-foreground">{help.shortDescription}</p>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Einrichtung:</h4>
            <ol className="ml-4 list-decimal space-y-1 text-sm text-muted-foreground">
              {help.setupSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>

          {help.envVars && help.envVars.length > 0 && (
            <div className="space-y-4 border-t border-border pt-4">
              <h4 className="text-sm font-semibold">API-Keys konfigurieren:</h4>
              <ProviderEnvEditor
                providerId={providerId}
                envVars={help.envVars}
                onSaveComplete={() => void onProviderSaved()}
                onProviderActivate={() => onProviderActivate(providerId)}
              />
            </div>
          )}

          {help.cliCommands && help.cliCommands.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">CLI-Befehle:</h4>
              <div className="space-y-2">
                {help.cliCommands.map((command, index) => (
                  <div key={index} className="rounded bg-black/90 p-2 font-mono text-xs text-white">
                    <span className="text-green-400">$</span> {command.command}
                    <p className="mt-1 text-gray-400">{command.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {help.notes && help.notes.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">Hinweise:</h4>
              <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
                {help.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {help.documentationUrl && (
            <div className="border-t border-border pt-2">
              <a
                href={help.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-xs text-primary hover:underline"
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Offizielle Dokumentation öffnen
              </a>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
