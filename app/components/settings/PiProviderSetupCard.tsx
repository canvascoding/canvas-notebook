'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
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

function translateProviderHelpText(text: string, locale: string): string {
  if (locale !== 'de') {
    return text;
  }

  if (/[äöüÄÖÜß]/.test(text)) {
    return text;
  }

  const exactMatches: Record<string, string> = {
    'OpenAI API (GPT-4, GPT-3.5, etc.)': 'OpenAI API (GPT-4, GPT-3.5 usw.)',
    'Anthropic Claude API (API Key or OAuth)': 'Anthropic Claude API (API-Key oder OAuth)',
    'Google Gemini API': 'Google Gemini API',
    'Fast inference with OpenAI-compatible API': 'Schnelle Inferenz mit OpenAI-kompatibler API',
    'Mistral AI API': 'Mistral AI API',
    'Unified API for multiple AI models': 'Einheitliche API fuer mehrere KI-Modelle',
    'zAI GLM models': 'zAI-GLM-Modelle',
    'Cerebras inference API': 'Cerebras Inference-API',
    'xAI Grok models': 'xAI-Grok-Modelle',
    'HuggingFace inference API': 'HuggingFace Inference-API',
    'MiniMax AI models': 'MiniMax-KI-Modelle',
    'MiniMax China models': 'MiniMax-China-Modelle',
    'OpenCode Zen models': 'OpenCode-Zen-Modelle',
    'Moonshot AI Kimi models': 'Moonshot-AI-Kimi-Modelle',
    'OpenAI Codex via PI OAuth (requires ChatGPT Plus/Pro)': 'OpenAI Codex ueber PI OAuth (benoetigt ChatGPT Plus/Pro)',
    'Login with your OpenAI account (ChatGPT Plus/Pro required)': 'Melde dich mit deinem OpenAI-Konto an (ChatGPT Plus/Pro erforderlich)',
    'GitHub Copilot via PI OAuth': 'GitHub Copilot ueber PI OAuth',
    'Google Cloud Code Assist via PI OAuth': 'Google Cloud Code Assist ueber PI OAuth',
    'Free tier Gemini/Claude via Google Cloud': 'Kostenlose Gemini/Claude-Stufe ueber Google Cloud',
    'Google Vertex AI with Application Default Credentials': 'Google Vertex AI mit Application Default Credentials',
    'AWS Bedrock AI models': 'AWS-Bedrock-KI-Modelle',
    'Azure OpenAI Service': 'Azure OpenAI Service',
    'Choose your preferred authentication method below': 'Waehle unten deine bevorzugte Authentifizierungsmethode',
    'Add the key to Agent Environment settings': 'Trage den Key in den Agent-Environment-Einstellungen ein',
    'Add the key to Integrations or Agent Environment settings': 'Trage den Key in den Integrations- oder Agent-Environment-Einstellungen ein',
    'Save and verify the provider status': 'Speichere und pruefe den Provider-Status',
    'Verify the provider status': 'Pruefe den Provider-Status',
    'Click "Connect Account" in the OAuth section': 'Klicke im OAuth-Bereich auf "Konto verbinden"',
    'Open the authorization URL in your browser': 'Oeffne die Autorisierungs-URL in deinem Browser',
    'Copy the authorization code and paste it in the dialog': 'Kopiere den Autorisierungscode und fuege ihn in den Dialog ein',
    'Click "Complete Connection" to finish': 'Klicke auf "Verbindung abschliessen", um den Vorgang zu beenden',
    'Authorize the application on GitHub': 'Autorisiere die Anwendung bei GitHub',
    'Allow Google Cloud Code Assist access': 'Erlaube den Zugriff fuer Google Cloud Code Assist',
    'OAuth authentication is handled securely via PI': 'Die OAuth-Authentifizierung wird sicher ueber PI abgewickelt',
    'Credentials are stored encrypted in /data/canvas-agent/': 'Zugangsdaten werden verschluesselt in /data/canvas-agent/ gespeichert',
    'Token refresh is automatic': 'Die Token-Aktualisierung erfolgt automatisch',
    'Requires active ChatGPT Plus or Pro subscription': 'Benoetigt ein aktives ChatGPT-Plus- oder Pro-Abo',
    'Requires GitHub Copilot subscription': 'Benoetigt ein GitHub-Copilot-Abo',
    'Requires Google Cloud project': 'Benoetigt ein Google-Cloud-Projekt',
    'Free tier available through Google Cloud': 'Kostenlose Stufe ueber Google Cloud verfuegbar',
    'OAuth authentication required': 'OAuth-Authentifizierung erforderlich',
    'Supports both Gemini and Claude models': 'Unterstuetzt sowohl Gemini- als auch Claude-Modelle',
    'Install and configure Google Cloud SDK': 'Installiere und konfiguriere das Google Cloud SDK',
    'Install Google Cloud SDK': 'Installiere das Google Cloud SDK',
    'Configure AWS credentials': 'Konfiguriere AWS-Zugangsdaten',
    'Set up AWS profile or access keys': 'Richte ein AWS-Profil oder Access Keys ein',
    'Ensure Bedrock access is enabled in your AWS account': 'Stelle sicher, dass Bedrock-Zugriff in deinem AWS-Konto aktiviert ist',
    'Multiple authentication methods supported': 'Mehrere Authentifizierungsmethoden werden unterstuetzt',
    'Requires AWS account with Bedrock access': 'Benoetigt ein AWS-Konto mit Bedrock-Zugriff',
    'Uses standard AWS credential chain': 'Verwendet die standardmaessige AWS-Credential-Chain',
    'Create Azure OpenAI resource in Azure Portal': 'Erstelle eine Azure-OpenAI-Ressource im Azure-Portal',
    'Get your API key and endpoint': 'Hole deinen API-Key und Endpoint',
    'Add credentials to Agent Environment': 'Trage die Zugangsdaten in der Agent-Umgebung ein',
    'Requires Azure subscription': 'Benoetigt ein Azure-Abo',
    'Base URL or Resource Name is required': 'Base-URL oder Resource-Name ist erforderlich',
    'Deployment names must match your Azure configuration': 'Deployment-Namen muessen zu deiner Azure-Konfiguration passen',
    'Uses Application Default Credentials (ADC)': 'Verwendet Application Default Credentials (ADC)',
    'Requires gcloud CLI to be installed': 'Benoetigt eine installierte gcloud-CLI',
    'Project and location must be configured': 'Projekt und Region muessen konfiguriert sein',
    'Login to Google Cloud': 'Bei Google Cloud anmelden',
    'Set your GCP project': 'GCP-Projekt setzen',
    'Set up Application Default Credentials': 'Application Default Credentials einrichten',
    'Set your region (e.g., us-central1)': 'Region setzen (z.B. us-central1)',
    'Configure AWS CLI with credentials': 'AWS-CLI mit Zugangsdaten konfigurieren',
    'Test Bedrock access': 'Bedrock-Zugriff testen'
  };

  if (exactMatches[text]) {
    return exactMatches[text];
  }

  return text
    .replace(/^Get your API key from (.+)$/u, 'Hole deinen API-Key von $1')
    .replace(/^Get your access token from (.+)$/u, 'Hole dein Access-Token von $1')
    .replace(/^Get your API key from your (.+) provider$/u, 'Hole deinen API-Key von deinem $1-Provider')
    .replace(/^Get your API key from (.+)$/u, 'Hole deinen API-Key von $1')
    .replace(/^For API Key: Get your key from (.+)$/u, 'Fuer API-Key: Hole deinen Key von $1')
    .replace(/^For OAuth: Click "Connect Account" and complete the OAuth flow$/u, 'Fuer OAuth: Klicke auf "Konto verbinden" und schliesse den OAuth-Flow ab')
    .replace(/^Select (.+) from the dropdown$/u, '$1 im Dropdown auswaehlen')
    .replace(/^Login with your (.+) account$/u, 'Melde dich mit deinem $1-Konto an')
    .replace(/^Login with your (.+) account \((.+)\)$/u, 'Melde dich mit deinem $1-Konto an ($2)')
    .replace(/^Authenticate: (.+)$/u, 'Authentifizieren: $1')
    .replace(/^Login via: (.+)$/u, 'Anmelden ueber: $1')
    .replace(/^Set the Antigravity version if needed$/u, 'Setze bei Bedarf die Antigravity-Version')
    .replace(/^Set your project and location$/u, 'Setze dein Projekt und deine Region')
    .replace(/^Your (.+) API key$/u, 'Dein $1 API-Key')
    .replace(/^Your (.+) access token$/u, 'Dein $1 Access-Token')
    .replace(/^Your (.+) project ID$/u, 'Deine $1 Projekt-ID')
    .replace(/^Your (.+) project$/u, 'Dein $1 Projekt')
    .replace(/^Region \((.+)\)$/u, 'Region ($1)')
    .replace(/^AWS profile name$/u, 'AWS-Profilname')
    .replace(/^AWS access key$/u, 'AWS Access Key')
    .replace(/^AWS secret key$/u, 'AWS Secret Key')
    .replace(/^AWS bearer token for Bedrock$/u, 'AWS Bearer-Token fuer Bedrock')
    .replace(/^Web identity token file path$/u, 'Pfad zur Web-Identity-Token-Datei')
    .replace(/^Azure OpenAI endpoint URL$/u, 'Azure-OpenAI-Endpoint-URL')
    .replace(/^Resource name \(alternative to base URL\)$/u, 'Resource-Name (Alternative zur Base-URL)')
    .replace(/^API version \(optional\)$/u, 'API-Version (optional)')
    .replace(/^Deployment name mappings \(optional\)$/u, 'Deployment-Name-Zuordnungen (optional)')
    .replace(/^Override User-Agent version$/u, 'User-Agent-Version ueberschreiben');
}

function localizeProviderHelp(help: ProviderHelpInfo, locale: string): ProviderHelpInfo {
  if (locale !== 'de') {
    return help;
  }

  return {
    ...help,
    shortDescription: translateProviderHelpText(help.shortDescription, locale),
    setupSteps: help.setupSteps.map((step) => translateProviderHelpText(step, locale)),
    envVars: help.envVars?.map((envVar) => ({
      ...envVar,
      description: translateProviderHelpText(envVar.description, locale),
    })),
    cliCommands: help.cliCommands?.map((command) => ({
      ...command,
      description: translateProviderHelpText(command.description, locale),
    })),
    notes: help.notes?.map((note) => translateProviderHelpText(note, locale)),
    ollamaModes: help.ollamaModes?.map((mode) => ({
      ...mode,
      label: translateProviderHelpText(mode.label, locale),
      description: translateProviderHelpText(mode.description, locale),
      setupSteps: mode.setupSteps.map((step) => translateProviderHelpText(step, locale)),
      notes: mode.notes.map((note) => translateProviderHelpText(note, locale)),
    })),
  };
}

export function PiProviderSetupCard({
  title,
  description,
  saveButtonLabel,
  saveSuccessMessage,
  onSaved,
}: PiProviderSetupCardProps) {
  const locale = useLocale();
  const t = useTranslations('settings');
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
  const resolvedTitle = title ?? t('provider.cardTitle');
  const resolvedDescription = description ?? t('provider.cardDescription');
  const resolvedSaveButtonLabel = saveButtonLabel ?? t('provider.saveButton');
  const resolvedSaveSuccessMessage = saveSuccessMessage ?? t('provider.saveSuccess');
  const terminalPath = `/${locale}/terminal`;

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
      setConfigError(error instanceof Error ? error.message : t('provider.errors.failedToLoadConfig'));
    } finally {
      setConfigLoading(false);
    }
  }, [t]);

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
      setConfigError(t('provider.errors.selectModel', { provider: piConfigDraft.activeProvider }));
      setConfigSuccess(null);
      return;
    }

    if (piConfigDraft.activeProvider === 'ollama') {
      if (activeProviderConfig.ollamaModelSource === 'custom' && !activeProviderConfig.ollamaCustomModel?.trim()) {
        setConfigError(t('provider.errors.customModelName'));
        setConfigSuccess(null);
        return;
      }

      if ((activeProviderConfig.ollamaMode || 'local') === 'cloud' && !activeProviderConfig.ollamaHost?.trim()) {
        setConfigError(t('provider.errors.remoteUrl'));
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
      setConfigSuccess(resolvedSaveSuccessMessage);
      await onSaved?.({ piConfig: payload.piConfig, readiness: payload.readiness });
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : t('provider.errors.failedToSaveConfig'));
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
        {t('provider.loadingConfig')}
      </div>
    );
  }

  if (!piConfigDraft) {
    return (
      <div className="rounded border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {configError || t('provider.loadConfigFailed')}
      </div>
    );
  }

  const activeProviderConfig = piConfigDraft.providers[piConfigDraft.activeProvider];

  return (
    <Card className="border-primary shadow-sm">
      <CardHeader>
        <CardTitle>{resolvedTitle}</CardTitle>
        <CardDescription>{resolvedDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-semibold">{t('provider.activeProvider')}</span>
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
              <span className="font-semibold">{t('provider.modelFor', { provider: piConfigDraft.activeProvider })}</span>

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
                    <option value="">{t('provider.selectModel')}</option>
                    {(discovery[piConfigDraft.activeProvider]?.models || []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.id} {model.supportsVision ? '👁️' : ''}
                      </option>
                    ))}
                    <option value="custom">{t('provider.customModelOption')}</option>
                  </select>

                  {piConfigDraft.providers.ollama?.ollamaModelSource === 'custom' && (
                    <div className="mt-3 space-y-2">
                      <Input
                        data-testid="ollama-custom-model-input"
                        placeholder={t('provider.customModelPlaceholder')}
                        value={piConfigDraft.providers.ollama?.ollamaCustomModel || ''}
                        onChange={(event) => {
                          const customModel = event.target.value;
                          setPiProviderField('ollama', 'ollamaCustomModel', customModel);
                          setPiProviderField('ollama', 'model', customModel);
                        }}
                        disabled={configSaving}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('provider.customModelHelp')}
                      </p>
                    </div>
                  )}

                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('provider.visionLegendWithCustom')}
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
                    <option value="">{t('provider.selectModel')}</option>
                    {(discovery[piConfigDraft.activeProvider]?.models || []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.id} {model.supportsVision ? '👁️' : ''}
                      </option>
                    ))}
                    {!discovery[piConfigDraft.activeProvider] && (
                      <option value={activeProviderConfig.model}>
                        {activeProviderConfig.model} {t('provider.manualModelSuffix')}
                      </option>
                    )}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">{t('provider.visionLegend')}</p>
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
                <span className="font-medium">{t('provider.ollamaConfiguration')}</span>
                <span className="rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">
                  {(piConfigDraft.providers.ollama?.ollamaMode || 'local') === 'cloud' ? t('provider.remoteServer') : t('provider.standardLocal')}
                </span>
              </div>
              {isOllamaConfigOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-4 rounded-b border-x border-b border-border bg-muted/20 p-4 text-sm">
                <div className="space-y-2">
                  <span className="font-semibold">{t('provider.ollamaServer')}</span>
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
                    <option value="local">{t('provider.standardLocalOption')}</option>
                    <option value="cloud">{t('provider.remoteServerOption')}</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {piConfigDraft.providers.ollama?.ollamaMode === 'cloud'
                      ? t('provider.remoteServerHelp')
                      : t('provider.standardLocalHelp')}
                  </p>
                </div>

                {piConfigDraft.providers.ollama?.ollamaMode === 'cloud' && (
                  <div className="space-y-2">
                    <span className="font-semibold">{t('provider.remoteServerUrl')}</span>
                    <Input
                      data-testid="ollama-remote-url"
                      placeholder={t('provider.remoteServerUrlPlaceholder')}
                      value={piConfigDraft.providers.ollama?.ollamaHost || ''}
                      onChange={(event) => setPiProviderField('ollama', 'ollamaHost', event.target.value)}
                      disabled={configSaving}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('provider.remoteServerUrlHelp')}
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-2 rounded-md border border-border bg-background p-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{t('provider.terminalConfigTitle')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('provider.terminalConfigDescription')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(terminalPath, '_blank')}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t('provider.openTerminal')}
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-semibold">{t('provider.thinkingLevel')}</span>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={activeProviderConfig?.thinking || 'none'}
              onChange={(event) => setPiProviderField(piConfigDraft.activeProvider, 'thinking', event.target.value as PiThinkingLevel)}
              disabled={configSaving}
            >
              <option value="none">{t('provider.thinkingLevels.none')}</option>
              <option value="low">{t('provider.thinkingLevels.low')}</option>
              <option value="medium">{t('provider.thinkingLevels.medium')}</option>
              <option value="high">{t('provider.thinkingLevels.high')}</option>
            </select>
          </label>

          <div className="rounded border border-border bg-muted/40 p-3 text-xs">
            <p className="mb-1 font-semibold">{t('provider.providerStatus')}</p>
            {selectedProviderLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="text-muted-foreground">{t('provider.checking')}</span>
              </div>
            ) : (
              <>
                <p className={selectedProviderStatus?.isReady ? 'text-primary' : 'font-bold text-destructive'}>
                  {selectedProviderStatus?.isReady ? t('provider.providerReady') : t('provider.providerNotReady')}
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
            <h4 className="text-sm font-semibold">{t('provider.authenticationMethod')}</h4>
            <p className="text-xs text-muted-foreground">
              {t('provider.authenticationMethodDescription')}
            </p>
            <div className="flex gap-2">
              <Button
                variant={activeProviderConfig?.authMethod === 'api-key' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPiProviderField(piConfigDraft.activeProvider, 'authMethod', 'api-key')}
                className="flex-1"
              >
                {t('provider.apiKey')}
              </Button>
              <Button
                variant={activeProviderConfig?.authMethod === 'oauth' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPiProviderField(piConfigDraft.activeProvider, 'authMethod', 'oauth')}
                className="flex-1"
              >
                {t('provider.oauthCli')}
              </Button>
            </div>

            {activeProviderConfig?.authMethod === 'api-key' && (
              <div className="mt-3 rounded bg-muted/50 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium">{t('provider.apiKeySetupTitle')}</p>
                <p>{t('provider.apiKeySetupDescription')}</p>
              </div>
            )}

            {activeProviderConfig?.authMethod === 'oauth' && (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t('provider.oauthStatus')}</span>
                  {selectedProviderStatus?.hasOAuth ? (
                    <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                      <Check className="h-3 w-3" />
                      {t('provider.connected')}
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                      {t('provider.notConnected')}
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
                <h4 className="text-sm font-semibold">{t('provider.oauthAuthentication')}</h4>
                {selectedProviderStatus?.hasOAuth ? (
                  <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                    <Check className="h-3 w-3" />
                    {t('provider.connected')}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    {t('provider.notConnected')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('provider.oauthAuthenticationDescription')}
              </p>
              <PiOAuthButton onStatusChange={() => void loadProviderStatus(piConfigDraft.activeProvider)} />
            </div>
          )}

        <div className="rounded border border-border bg-muted/20 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-tight text-muted-foreground">{t('provider.systemInfo')}</p>
          <p className="text-xs text-muted-foreground">
            {t('provider.systemInfoDescription')}
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
            {resolvedSaveButtonLabel}
          </Button>
          <Button variant="outline" onClick={() => void loadConfig()} disabled={configLoading || configSaving}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('provider.reload')}
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
  const locale = useLocale();
  const t = useTranslations('settings');
  const baseHelp = getProviderHelp(providerId);
  const help = baseHelp ? localizeProviderHelp(baseHelp, locale) : undefined;

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
        return t('providerHelp.categoryLabels.apiKey');
      case 'oauth-cli':
        return t('providerHelp.categoryLabels.oauthCli');
      case 'adc':
        return t('providerHelp.categoryLabels.adc');
      case 'aws':
        return t('providerHelp.categoryLabels.aws');
      case 'azure':
        return t('providerHelp.categoryLabels.azure');
      case 'ollama':
        return t('providerHelp.categoryLabels.ollama');
      default:
        return t('providerHelp.categoryLabels.unknown');
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded border border-border bg-muted/30 p-3 text-sm transition-colors hover:bg-muted/50">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">
            {t('providerHelp.configurationTitle', { icon: getCategoryIcon(help.category), title: help.title })}
          </span>
          {isProviderReady && (
            <span className="ml-2 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {t('providerHelp.configured')}
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
            <h4 className="text-sm font-semibold">{t('providerHelp.setup')}</h4>
            <ol className="ml-4 list-decimal space-y-1 text-sm text-muted-foreground">
              {help.setupSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>

          {help.envVars && help.envVars.length > 0 && (
            <div className="space-y-4 border-t border-border pt-4">
              <h4 className="text-sm font-semibold">{t('providerHelp.configureApiKeys')}</h4>
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
              <h4 className="text-sm font-semibold">{t('providerHelp.cliCommands')}</h4>
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
              <h4 className="text-sm font-semibold">{t('providerHelp.notes')}</h4>
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
                {t('providerHelp.openDocs')}
              </a>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
