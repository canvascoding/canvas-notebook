'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Settings2,
} from 'lucide-react';

import {
  getAllowedCredentialScopesForProvider,
  validateProviderCatalogAuth,
} from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import type {
  AiCatalogDiscoveryModel,
  AiCredentialScope,
  AiProviderSource,
  AiProviderStatus,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import { AI_THINKING_LEVELS } from '@/app/lib/agent-runtime-policy/types';
import { defaultOllamaServerUrl } from '@/app/lib/agent-runtime-policy/ollama-url';
import { getAuthMethodForProvider } from '@/app/lib/pi/provider-help';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import {
  AiProviderCatalogCard,
  type AiProviderCatalogCardCopy,
} from './ai-runtime/AiProviderCatalogCard';
import {
  AiProviderEditorDialog,
  type AiProviderEditorCopy,
  type AiProviderEditorOption,
} from './ai-runtime/AiProviderEditorDialog';
import {
  catalogDataToDraft,
  readAdminRuntimeCatalog,
  RuntimeCatalogClientError,
  syncManagedRuntimeCatalog,
  updateAdminRuntimeCatalog,
  verifyAdminProviderInstallation,
  type AdminRuntimeCatalogData,
  type AiCatalogProviderDraft,
  type AiRuntimeCatalogDraft,
} from './ai-runtime/catalog-client';

const CONTROL_PLANE_PROVIDER_ID = 'canvas-control-plane';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;

type DeploymentMode = 'self-hosted' | 'managed';
type PanelCopy = {
  title: string;
  description: string;
  loading: string;
  retry: string;
  reload: string;
  saved: string;
  verified: string;
  setupDetails: string;
  setupDetailsDescription: string;
  reviewIssue: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultEmpty: string;
  defaultReady: string;
  defaultEdit: string;
  defaultDialogTitle: string;
  defaultProvider: string;
  defaultModel: string;
  intelligence: string;
  saveDefault: string;
  onboardingEmptyTitle: string;
  onboardingEmptyDescription: string;
  onboardingConfigure: string;
  onboardingReadyDescription: string;
  onboardingNeedsReviewDescription: string;
  onboardingEndpoint: string;
  onboardingModel: string;
  onboardingScope: string;
  onboardingChange: string;
  onboardingUseOther: string;
  providersTitle: string;
  providersDescription: string;
  addProvider: string;
  addProviderTitle: string;
  addProviderDescription: string;
  provider: string;
  credentialScope: string;
  chooseProvider: string;
  continue: string;
  cancel: string;
  noProvidersTitle: string;
  noProvidersDescription: string;
  noProvidersAvailable: string;
  managedTitle: string;
  managedDescription: string;
  managedSync: string;
  managedSyncing: string;
  managedReady: string;
  managedAvailable: string;
  managedUnavailable: string;
  errors: {
    load: string;
    save: string;
    sync: string;
    verify: string;
    revisionConflict: string;
    duplicateBinding: string;
    invalidAuthMethod: (provider: string) => string;
    oauthScope: (provider: string) => string;
    openAiBaseUrl: string;
    ollamaHost: string;
    customModel: string;
    enabledProviderModels: (provider: string) => string;
    providerDefault: (provider: string) => string;
    defaultInvalid: string;
  };
  intelligenceLevel: Record<PiThinkingLevel, string>;
  providerCard: AiProviderCatalogCardCopy;
  editor: AiProviderEditorCopy;
};

const STATUS_DE: Record<AiProviderStatus, string> = {
  unverified: 'Nicht geprüft',
  ready: 'Verbunden',
  degraded: 'Prüfung fehlgeschlagen',
  disabled: 'Inaktiv',
};
const STATUS_EN: Record<AiProviderStatus, string> = {
  unverified: 'Not verified',
  ready: 'Connected',
  degraded: 'Check failed',
  disabled: 'Inactive',
};
const SOURCE_DE: Record<AiProviderSource, string> = {
  managed: 'Managed',
  'built-in': 'Cloud-Provider',
  'self-hosted': 'Eigener Server',
};
const SOURCE_EN: Record<AiProviderSource, string> = {
  managed: 'Managed',
  'built-in': 'Cloud provider',
  'self-hosted': 'Self-hosted',
};
const SCOPE_DE: Record<AiCredentialScope, string> = {
  managed: 'Managed · Control Plane',
  system: 'Systemweit',
  organization: 'Organisation',
  user: 'Pro Nutzer',
};
const SCOPE_EN: Record<AiCredentialScope, string> = {
  managed: 'Managed · Control Plane',
  system: 'System wide',
  organization: 'Organization',
  user: 'Per user',
};

const DE_COPY: PanelCopy = {
  title: 'KI-Provider & Modelle',
  description: 'Verwalte Verbindungen und Modelle, ohne die technischen Details dauerhaft im Blick haben zu müssen.',
  loading: 'KI-Provider werden geladen …',
  retry: 'Erneut versuchen',
  reload: 'Neu laden',
  saved: 'Die Provider-Einstellungen wurden gespeichert.',
  verified: 'Die Verbindung wurde gespeichert und erfolgreich geprüft.',
  setupDetails: 'Hinweise zur Einrichtung',
  setupDetailsDescription: 'Zugangsdaten werden im gewählten Credential-Scope geschützt gespeichert. Der Modellkatalog enthält ausschließlich sichere Verbindungs- und Modellmetadaten.',
  reviewIssue: 'Hinweiscode',
  defaultTitle: 'Standard für neue Chats',
  defaultDescription: 'Dieses Modell verwendet Canvas, wenn kein persönlicherer Standard ausgewählt wurde.',
  defaultEmpty: 'Noch kein Standard festgelegt',
  defaultReady: 'Bereit für neue Chats',
  defaultEdit: 'Bearbeiten',
  defaultDialogTitle: 'Standard für neue Chats bearbeiten',
  defaultProvider: 'Provider',
  defaultModel: 'Modell',
  intelligence: 'Intelligence',
  saveDefault: 'Standard speichern',
  onboardingEmptyTitle: 'KI-Provider einrichten',
  onboardingEmptyDescription: 'Verbinde Canvas mit dem Provider und Modell, das Chats und Automationen ausführen soll.',
  onboardingConfigure: 'Provider einrichten',
  onboardingReadyDescription: 'Canvas ist mit diesem Provider verbunden. Technische Details kannst du später in den Einstellungen ändern.',
  onboardingNeedsReviewDescription: 'Provider und Standardmodell sind ausgewählt. Öffne die Einrichtung, um die Verbindung zu prüfen.',
  onboardingEndpoint: 'Verbindung',
  onboardingModel: 'Standardmodell',
  onboardingScope: 'Verfügbar für',
  onboardingChange: 'Einrichtung ändern',
  onboardingUseOther: 'Anderen Provider verwenden',
  providersTitle: 'Provider',
  providersDescription: 'Die Übersicht zeigt nur den aktuellen Zustand. Verbindung, Modelle und Zugriff bearbeitest du im Dialog.',
  addProvider: 'Provider hinzufügen',
  addProviderTitle: 'Provider hinzufügen',
  addProviderDescription: 'Wähle zunächst den Anbieter und den Zugriff. Die eigentliche Einrichtung folgt im nächsten Dialog.',
  provider: 'Provider',
  credentialScope: 'Verfügbar für',
  chooseProvider: 'Provider auswählen',
  continue: 'Weiter zur Einrichtung',
  cancel: 'Abbrechen',
  noProvidersTitle: 'Noch keine Provider eingerichtet',
  noProvidersDescription: 'Füge einen Provider hinzu und richte anschließend Verbindung und Modelle ein.',
  noProvidersAvailable: 'Alle Provider sind bereits in ihren verfügbaren Scopes eingerichtet.',
  managedTitle: 'Canvas Control Plane',
  managedDescription: 'Synchronisiert zentral freigegebene Managed-Modelle.',
  managedSync: 'Managed-Katalog synchronisieren',
  managedSyncing: 'Synchronisiert …',
  managedReady: 'Verbunden',
  managedAvailable: 'Verfügbar',
  managedUnavailable: 'Nicht verbunden',
  errors: {
    load: 'Der KI-Katalog konnte nicht geladen werden.',
    save: 'Die Provider-Einstellungen konnten nicht gespeichert werden.',
    sync: 'Der Managed-Katalog konnte nicht synchronisiert werden.',
    verify: 'Die Verbindung konnte nicht verifiziert werden.',
    revisionConflict: 'Der Katalog wurde zwischenzeitlich geändert. Lade ihn neu und wiederhole die Änderung.',
    duplicateBinding: 'Diese Kombination aus Provider und Credential-Scope ist bereits vorhanden.',
    invalidAuthMethod: (provider) => `Die gewählte Authentifizierung wird von „${provider}“ nicht unterstützt.`,
    oauthScope: (provider) => `„${provider}“ benötigt für OAuth den Scope „Pro Nutzer“.`,
    openAiBaseUrl: 'Trage eine gültige HTTP(S)-Base-URL ohne Zugangsdaten ein.',
    ollamaHost: 'Trage eine gültige HTTP(S)-URL für den Ollama-Server ein.',
    customModel: 'Trage eine gültige Modell-ID ein.',
    enabledProviderModels: (provider) => `Der aktive Provider „${provider}“ benötigt mindestens ein freigegebenes Modell.`,
    providerDefault: (provider) => `Wähle für „${provider}“ ein Standardmodell aus.`,
    defaultInvalid: 'Der Standard muss auf einen aktiven Provider und ein freigegebenes Modell verweisen.',
  },
  intelligenceLevel: {
    off: 'Aus',
    minimal: 'Minimal',
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
    xhigh: 'Sehr hoch',
    max: 'Maximum',
  },
  providerCard: {
    edit: 'Bearbeiten',
    enabled: 'Aktiv',
    disabled: 'Inaktiv',
    providerDefault: 'Standard',
    appDefault: 'Chat-Standard',
    selectedModels: (selected) => `${selected} ${selected === 1 ? 'Modell' : 'Modelle'}`,
    endpointNotConfigured: 'Verbindung noch nicht eingerichtet',
    status: STATUS_DE,
    source: SOURCE_DE,
    scope: SCOPE_DE,
  },
  editor: {
    addTitle: 'Provider einrichten',
    editTitle: 'Provider bearbeiten',
    description: 'Verbindung, Modelle und Zugriff sind in einer klaren Reihenfolge angeordnet.',
    provider: 'Provider',
    chooseProvider: 'Provider auswählen',
    connectionStep: 'Verbindung',
    connectionDescription: 'Verbinde Canvas zuerst mit dem Provider. Je nach Anbieter sind dafür eine Server-Adresse, Zugangsdaten oder eine Kontoanmeldung nötig.',
    modelsStep: 'Modelle',
    modelsDescription: 'Gib nur die Modelle frei, die in Canvas auswählbar sein sollen.',
    accessStep: 'Zugriff',
    accessDescription: 'Bestimme abschließend Sichtbarkeit und Aktivierungsstatus.',
    serverUrl: 'Server-URL',
    serverUrlHint: 'Die URL wird aus Sicht der Canvas-Runtime aufgerufen. In einem Container zeigt localhost auf den Container selbst.',
    serverUrlPlaceholder: 'http://ollama:11434',
    openAiCompatibleUrlPlaceholder: 'https://api.example.com/v1',
    apiKey: 'API-Key',
    apiKeyOptional: 'Optional',
    apiKeyPlaceholder: 'Nur eintragen, wenn der Server Authentifizierung verlangt',
    testConnection: 'Verbindung testen & Modelle laden',
    testingConnection: 'Verbindung wird geprüft …',
    connectionReady: (count) => `Verbunden · ${count} ${count === 1 ? 'Modell gefunden' : 'Modelle gefunden'}`,
    noRemoteModels: 'Verbunden, aber auf diesem Server wurden keine Modelle gefunden.',
    discoverFirst: 'Teste die Verbindung, um die Modelle dieses Ollama-Servers zu laden.',
    configureManually: 'Modell stattdessen manuell eintragen',
    continueToModels: 'Weiter zu den Modellen',
    manualModel: 'Modell manuell hinzufügen',
    manualModelPlaceholder: 'z. B. qwen3:14b oder llama3.3:70b',
    addModel: 'Hinzufügen',
    searchModels: 'Modelle durchsuchen …',
    allowed: 'Freigegeben',
    providerDefault: 'Provider-Standard',
    noModels: 'Keine Modelle verfügbar.',
    authentication: 'Anmeldung',
    apiKeyAuthentication: 'API-Key',
    oauthAuthentication: 'Mit Konto anmelden',
    credentialScope: 'Verfügbar für',
    providerEnabled: 'Provider aktivieren',
    providerEnabledHint: 'Neue Provider bleiben inaktiv, bis du sie bewusst einschaltest.',
    credentials: 'Zugangsdaten',
    credentialsDescription: 'API-Keys werden geschützt im gewählten Scope gespeichert und nicht in den Modellkatalog geschrieben.',
    cancel: 'Abbrechen',
    save: 'Änderungen speichern',
    saveAndVerify: 'Speichern & prüfen',
    saveVerifyAndUse: 'Speichern, prüfen und als Standard verwenden',
    saving: 'Wird gespeichert …',
    remove: 'Provider entfernen',
    errors: {
      invalidUrl: 'Trage eine gültige HTTP(S)-Server-URL ein.',
      invalidModel: 'Trage eine gültige Modell-ID ohne Leerzeichen ein.',
      enabledNeedsModel: 'Wähle mindestens ein Modell aus, bevor du den Provider aktivierst.',
      defaultRequired: 'Wähle für die freigegebenen Modelle einen Provider-Standard.',
      discovery: 'Die Modelle konnten nicht vom Ollama-Server geladen werden.',
      credentialLoad: 'Der Ollama API-Key konnte nicht geladen werden.',
      credentialSave: 'Die Provider-Einstellungen konnten nicht gespeichert werden.',
    },
    scope: SCOPE_DE,
  },
};

const EN_COPY: PanelCopy = {
  title: 'AI providers & models',
  description: 'Manage connections and models without keeping every technical detail on screen.',
  loading: 'Loading AI providers…',
  retry: 'Try again',
  reload: 'Reload',
  saved: 'The provider settings were saved.',
  verified: 'The connection was saved and verified successfully.',
  setupDetails: 'Setup notes',
  setupDetailsDescription: 'Credentials are protected in the selected credential scope. The model catalog contains only safe connection and model metadata.',
  reviewIssue: 'Issue code',
  defaultTitle: 'Default for new chats',
  defaultDescription: 'Canvas uses this model when no more personal default has been selected.',
  defaultEmpty: 'No default selected yet',
  defaultReady: 'Ready for new chats',
  defaultEdit: 'Edit',
  defaultDialogTitle: 'Edit default for new chats',
  defaultProvider: 'Provider',
  defaultModel: 'Model',
  intelligence: 'Intelligence',
  saveDefault: 'Save default',
  onboardingEmptyTitle: 'Set up an AI provider',
  onboardingEmptyDescription: 'Connect Canvas to the provider and model that should run chats and automations.',
  onboardingConfigure: 'Set up provider',
  onboardingReadyDescription: 'Canvas is connected to this provider. You can change technical details later in Settings.',
  onboardingNeedsReviewDescription: 'The provider and default model are selected. Open setup to verify the connection.',
  onboardingEndpoint: 'Connection',
  onboardingModel: 'Default model',
  onboardingScope: 'Available to',
  onboardingChange: 'Change setup',
  onboardingUseOther: 'Use another provider',
  providersTitle: 'Providers',
  providersDescription: 'The overview shows current state only. Edit connection, models, and access in the dialog.',
  addProvider: 'Add provider',
  addProviderTitle: 'Add provider',
  addProviderDescription: 'Choose the provider and access scope first. Setup continues in the next dialog.',
  provider: 'Provider',
  credentialScope: 'Available to',
  chooseProvider: 'Select provider',
  continue: 'Continue to setup',
  cancel: 'Cancel',
  noProvidersTitle: 'No providers configured',
  noProvidersDescription: 'Add a provider, then configure its connection and models.',
  noProvidersAvailable: 'Every provider is already configured in its available scopes.',
  managedTitle: 'Canvas Control Plane',
  managedDescription: 'Synchronizes centrally approved managed models.',
  managedSync: 'Sync managed catalog',
  managedSyncing: 'Synchronizing…',
  managedReady: 'Connected',
  managedAvailable: 'Available',
  managedUnavailable: 'Not connected',
  errors: {
    load: 'The AI catalog could not be loaded.',
    save: 'The provider settings could not be saved.',
    sync: 'The managed catalog could not be synchronized.',
    verify: 'The connection could not be verified.',
    revisionConflict: 'The catalog changed in another session. Reload it and repeat the change.',
    duplicateBinding: 'This provider and credential scope combination already exists.',
    invalidAuthMethod: (provider) => `The selected authentication method is not supported by “${provider}”.`,
    oauthScope: (provider) => `“${provider}” requires the “Per user” scope for OAuth.`,
    openAiBaseUrl: 'Enter a valid HTTP(S) base URL without embedded credentials.',
    ollamaHost: 'Enter a valid HTTP(S) Ollama server URL.',
    customModel: 'Enter a valid model ID.',
    enabledProviderModels: (provider) => `The active provider “${provider}” needs at least one allowed model.`,
    providerDefault: (provider) => `Choose a default model for “${provider}”.`,
    defaultInvalid: 'The default must reference an active provider and an allowed model.',
  },
  intelligenceLevel: {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Maximum',
  },
  providerCard: {
    edit: 'Edit',
    enabled: 'Active',
    disabled: 'Inactive',
    providerDefault: 'Default',
    appDefault: 'Chat default',
    selectedModels: (selected) => `${selected} ${selected === 1 ? 'model' : 'models'}`,
    endpointNotConfigured: 'Connection not configured yet',
    status: STATUS_EN,
    source: SOURCE_EN,
    scope: SCOPE_EN,
  },
  editor: {
    addTitle: 'Set up provider',
    editTitle: 'Edit provider',
    description: 'Connection, models, and access follow one clear sequence.',
    provider: 'Provider',
    chooseProvider: 'Select provider',
    connectionStep: 'Connection',
    connectionDescription: 'Connect Canvas to the provider first. Depending on the provider, this requires a server address, credentials, or account sign-in.',
    modelsStep: 'Models',
    modelsDescription: 'Allow only the models that should be selectable in Canvas.',
    accessStep: 'Access',
    accessDescription: 'Finish by choosing visibility and activation.',
    serverUrl: 'Server URL',
    serverUrlHint: 'The URL is requested from the Canvas runtime. Inside a container, localhost refers to that container.',
    serverUrlPlaceholder: 'http://ollama:11434',
    openAiCompatibleUrlPlaceholder: 'https://api.example.com/v1',
    apiKey: 'API key',
    apiKeyOptional: 'Optional',
    apiKeyPlaceholder: 'Only needed when the server requires authentication',
    testConnection: 'Test connection & load models',
    testingConnection: 'Testing connection…',
    connectionReady: (count) => `Connected · ${count} ${count === 1 ? 'model found' : 'models found'}`,
    noRemoteModels: 'Connected, but no models were found on this server.',
    discoverFirst: 'Test the connection to load models from this Ollama server.',
    configureManually: 'Enter a model manually instead',
    continueToModels: 'Continue to models',
    manualModel: 'Add model manually',
    manualModelPlaceholder: 'e.g. qwen3:14b or llama3.3:70b',
    addModel: 'Add',
    searchModels: 'Search models…',
    allowed: 'Allowed',
    providerDefault: 'Provider default',
    noModels: 'No models available.',
    authentication: 'Sign-in method',
    apiKeyAuthentication: 'API key',
    oauthAuthentication: 'Sign in with account',
    credentialScope: 'Available to',
    providerEnabled: 'Enable provider',
    providerEnabledHint: 'New providers remain inactive until you explicitly enable them.',
    credentials: 'Credentials',
    credentialsDescription: 'API keys are protected in the selected scope and are never written to the model catalog.',
    cancel: 'Cancel',
    save: 'Save changes',
    saveAndVerify: 'Save & verify',
    saveVerifyAndUse: 'Save, verify, and use as default',
    saving: 'Saving…',
    remove: 'Remove provider',
    errors: {
      invalidUrl: 'Enter a valid HTTP(S) server URL.',
      invalidModel: 'Enter a valid model ID without spaces.',
      enabledNeedsModel: 'Select at least one model before enabling the provider.',
      defaultRequired: 'Choose a provider default for the allowed models.',
      discovery: 'Models could not be loaded from the Ollama server.',
      credentialLoad: 'The Ollama API key could not be loaded.',
      credentialSave: 'The provider settings could not be saved.',
    },
    scope: SCOPE_EN,
  },
};

export type AiProvidersModelsPanelProps = {
  locale?: string;
  deploymentMode?: DeploymentMode;
  className?: string;
  presentation?: 'settings' | 'onboarding';
  onCatalogChanged?: () => void;
  onOnboardingStateChange?: (state: { configured: boolean; ready: boolean }) => void;
  verifyProvider?: (providerInstallationId: string) => Promise<void>;
};

function copyForLocale(locale: string | undefined): PanelCopy {
  return locale?.toLowerCase().startsWith('de') ? DE_COPY : EN_COPY;
}

function isSafeEndpoint(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function selectionProvider(
  providers: readonly AiCatalogProviderDraft[],
  selection: AiRuntimeSelection | null,
): AiCatalogProviderDraft | undefined {
  if (!selection) return undefined;
  if (selection.providerInstallationId) {
    return providers.find((provider) => provider.providerInstallationId === selection.providerInstallationId);
  }
  const matches = providers.filter((provider) => provider.providerId === selection.providerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function modelForProvider(provider: AiCatalogProviderDraft, modelId: string): AiCatalogDiscoveryModel | undefined {
  return provider.availableModels.find((model) => model.id === modelId);
}

function sanitizeDefaultSelection(
  providers: readonly AiCatalogProviderDraft[],
  selection: AiRuntimeSelection | null,
): AiRuntimeSelection | null {
  const provider = selectionProvider(providers, selection);
  return selection && provider?.enabled && provider.modelIds.includes(selection.modelId)
    ? selection
    : null;
}

function validateDraft(draft: AiRuntimeCatalogDraft, copy: PanelCopy): string | null {
  const bindings = new Set<string>();
  for (const provider of draft.providers) {
    const binding = `${provider.providerId}\0${provider.credentialScope}`;
    if (bindings.has(binding)) return copy.errors.duplicateBinding;
    bindings.add(binding);
    const authIssue = validateProviderCatalogAuth(provider);
    if (authIssue === 'INVALID_PROVIDER_AUTH_METHOD') return copy.errors.invalidAuthMethod(provider.name);
    if (authIssue === 'OAUTH_REQUIRES_USER_SCOPE') return copy.errors.oauthScope(provider.name);
    if (provider.providerId === 'openai-compatible') {
      if (!isSafeEndpoint(provider.config.openaiCompatibleBaseUrl)) return copy.errors.openAiBaseUrl;
      const customModel = provider.config.openaiCompatibleCustomModel?.trim();
      if (customModel && !MODEL_ID_PATTERN.test(customModel)) return copy.errors.customModel;
    }
    if (provider.providerId === 'ollama' && !isSafeEndpoint(provider.config.ollamaHost)) {
      return copy.errors.ollamaHost;
    }
    if (provider.enabled && provider.modelIds.length === 0) {
      return copy.errors.enabledProviderModels(provider.name);
    }
    if (provider.modelIds.length > 0 && !provider.modelIds.includes(provider.defaultModelId)) {
      return copy.errors.providerDefault(provider.name);
    }
  }
  if (draft.defaultSelection) {
    const provider = selectionProvider(draft.providers, draft.defaultSelection);
    if (!provider?.enabled || !provider.modelIds.includes(draft.defaultSelection.modelId)) {
      return copy.errors.defaultInvalid;
    }
  }
  return null;
}

function availableCredentialScopesForNewProvider(
  providers: readonly AiCatalogProviderDraft[],
  providerId: string,
): readonly AiCredentialScope[] {
  const configured = new Set(providers
    .filter((provider) => provider.providerId === providerId)
    .map((provider) => provider.credentialScope));
  return getAllowedCredentialScopesForProvider(providerId)
    .filter((scope) => scope !== 'managed' && !configured.has(scope));
}

function errorMessage(error: unknown, fallback: string, copy: PanelCopy): string {
  if (error instanceof RuntimeCatalogClientError && error.code === 'CATALOG_REVISION_CONFLICT') {
    return copy.errors.revisionConflict;
  }
  return error instanceof Error ? error.message : fallback;
}

export function AiProvidersModelsPanel({
  locale,
  deploymentMode,
  className,
  presentation = 'settings',
  onCatalogChanged,
  onOnboardingStateChange,
  verifyProvider,
}: AiProvidersModelsPanelProps) {
  const copy = copyForLocale(locale);
  const isOnboarding = presentation === 'onboarding';
  const [data, setData] = useState<AdminRuntimeCatalogData | null>(null);
  const [draft, setDraft] = useState<AiRuntimeCatalogDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'sync' | 'default' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorProvider, setEditorProvider] = useState<AiCatalogProviderDraft | null>(null);
  const [editorIsNew, setEditorIsNew] = useState(false);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState<AiRuntimeSelection | null>(null);

  const applyCatalogData = useCallback((nextData: AdminRuntimeCatalogData) => {
    const nextDraft = catalogDataToDraft(nextData);
    setData(nextData);
    setDraft({
      ...nextDraft,
      providers: nextDraft.providers.map((provider) => provider.providerId === 'ollama'
        ? {
            ...provider,
            config: {
              ...provider.config,
              ollamaHost: provider.config.ollamaHost?.trim() || defaultOllamaServerUrl(),
              ollamaAdditionalModels: Array.from(new Set([
                ...(provider.config.ollamaAdditionalModels ?? []),
                ...(provider.config.ollamaCustomModel?.trim() ? [provider.config.ollamaCustomModel.trim()] : []),
              ])),
            },
          }
        : provider),
    });
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyCatalogData(await readAdminRuntimeCatalog());
      setMessage(null);
    } catch (loadError) {
      setError(errorMessage(loadError, copy.errors.load, copy));
    } finally {
      setLoading(false);
    }
  }, [applyCatalogData, copy]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadCatalog(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadCatalog]);

  const addableProviders = useMemo(() => {
    if (!data || !draft) return [];
    return Object.values(data.discovery)
      .filter((provider) => (
        provider.id !== CONTROL_PLANE_PROVIDER_ID
        && availableCredentialScopesForNewProvider(draft.providers, provider.id).length > 0
      ))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [data, draft]);
  const providerOptions: AiProviderEditorOption[] = addableProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    credentialScopes: draft
      ? availableCredentialScopesForNewProvider(draft.providers, provider.id)
      : [],
    installationIds: provider.installationIds,
  }));
  const managedProvider = draft?.providers.find((provider) => provider.providerId === CONTROL_PLANE_PROVIDER_ID);
  const managedDiscovered = Boolean(data?.discovery[CONTROL_PLANE_PROVIDER_ID]);
  const showManagedSync = deploymentMode === 'managed' || Boolean(managedProvider) || managedDiscovered;
  const defaultProvider = draft ? selectionProvider(draft.providers, draft.defaultSelection) : undefined;
  const defaultModel = defaultProvider && draft?.defaultSelection
    ? modelForProvider(defaultProvider, draft.defaultSelection.modelId)
    : undefined;
  const selectableDefaultProviders = draft?.providers.filter((provider) => (
    provider.enabled && provider.modelIds.length > 0
  )) ?? [];
  const onboardingConfigured = Boolean(defaultProvider && defaultModel);
  const onboardingReady = Boolean(
    onboardingConfigured
    && defaultProvider?.enabled
    && defaultProvider.status === 'ready',
  );

  useEffect(() => {
    if (!isOnboarding) return;
    onOnboardingStateChange?.({ configured: onboardingConfigured, ready: onboardingReady });
  }, [isOnboarding, onOnboardingStateChange, onboardingConfigured, onboardingReady]);

  const persistDraft = async (nextDraft: AiRuntimeCatalogDraft, successMessage = copy.saved) => {
    const validationError = validateDraft(nextDraft, copy);
    if (validationError) throw new Error(validationError);
    const nextData = await updateAdminRuntimeCatalog(nextDraft);
    applyCatalogData({ ...nextData, initialization: { action: 'existing', issueCode: null } });
    setMessage(successMessage);
    setError(null);
    onCatalogChanged?.();
    return nextData;
  };

  const saveProvider = async (provider: AiCatalogProviderDraft, options: { verify: boolean }) => {
    if (!draft) return;
    const exists = draft.providers.some((candidate) => candidate.clientKey === provider.clientKey);
    const providers = exists
      ? draft.providers.map((candidate) => candidate.clientKey === provider.clientKey ? provider : candidate)
      : [...draft.providers, provider];
    const onboardingDefault = provider.enabled && provider.defaultModelId
      ? {
          providerInstallationId: provider.providerInstallationId ?? '',
          providerId: provider.providerId,
          modelId: provider.defaultModelId,
          thinkingLevel: 'off' as const,
        }
      : null;
    const saved = await persistDraft({
      ...draft,
      providers,
      defaultSelection: isOnboarding
        ? onboardingDefault
        : sanitizeDefaultSelection(providers, draft.defaultSelection),
    });
    if (options.verify && provider.enabled) {
      const storedProvider = saved.catalog.providers.find((candidate) => (
        candidate.providerId === provider.providerId
        && candidate.credentialScope === provider.credentialScope
      ));
      if (!storedProvider) throw new Error(copy.errors.verify);
      if (verifyProvider) await verifyProvider(storedProvider.installationId);
      else await verifyAdminProviderInstallation(storedProvider.installationId);
      await loadCatalog();
      setMessage(copy.verified);
    }
    setEditorOpen(false);
  };

  const removeProvider = async (provider: AiCatalogProviderDraft) => {
    if (!draft) return;
    const providers = draft.providers.filter((candidate) => candidate.clientKey !== provider.clientKey);
    await persistDraft({
      ...draft,
      providers,
      defaultSelection: sanitizeDefaultSelection(providers, draft.defaultSelection),
    });
    setEditorOpen(false);
  };

  const newProviderDraft = (providerId: string): AiCatalogProviderDraft | null => {
    if (!data || !draft) return null;
    const discovered = data.discovery[providerId];
    if (!discovered) return null;
    const scope = availableCredentialScopesForNewProvider(draft.providers, providerId)[0];
    if (!scope) return null;
    const isOAuth = getAuthMethodForProvider(discovered.id) === 'oauth';
    return {
      clientKey: `new-${discovered.id}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      providerInstallationId: discovered.installationIds?.[scope],
      providerId: discovered.id,
      name: discovered.name,
      source: discovered.source,
      status: 'disabled',
      enabled: false,
      credentialScope: scope,
      config: isOAuth
        ? { authMethod: 'oauth' }
        : discovered.id === 'ollama'
          ? { ollamaHost: defaultOllamaServerUrl(), ollamaAdditionalModels: [] }
          : discovered.id === 'openai-compatible'
            ? { openaiCompatibleModelSource: 'custom' }
            : {},
      modelIds: [],
      defaultModelId: '',
      availableModels: [...discovered.models].sort((left, right) => left.name.localeCompare(right.name)),
      sourceRevision: null,
      lastSyncedAt: null,
    };
  };

  const openAddProvider = () => {
    const provider = newProviderDraft(addableProviders[0]?.id ?? '');
    if (!provider) return;
    setEditorProvider(provider);
    setEditorIsNew(true);
    setEditorOpen(true);
  };

  const changeNewProvider = (providerId: string) => {
    const provider = newProviderDraft(providerId);
    if (provider) setEditorProvider(provider);
  };

  const openProviderEditor = (provider: AiCatalogProviderDraft) => {
    setEditorProvider(provider);
    setEditorIsNew(false);
    setEditorOpen(true);
    setError(null);
    setMessage(null);
  };

  const openDefaultEditor = () => {
    if (!draft) return;
    const selection = draft.defaultSelection && selectionProvider(draft.providers, draft.defaultSelection)
      ? { ...draft.defaultSelection }
      : (() => {
          const provider = selectableDefaultProviders[0];
          if (!provider) return null;
          const modelId = provider.modelIds.includes(provider.defaultModelId)
            ? provider.defaultModelId
            : provider.modelIds[0];
          return {
            providerInstallationId: provider.providerInstallationId ?? '',
            providerId: provider.providerId,
            modelId,
            thinkingLevel: 'off' as const,
          };
        })();
    setDefaultDraft(selection);
    setDefaultOpen(true);
  };

  const saveDefault = async () => {
    if (!draft || !defaultDraft) return;
    setBusyAction('default');
    try {
      await persistDraft({ ...draft, defaultSelection: defaultDraft });
      setDefaultOpen(false);
    } catch (saveError) {
      setError(errorMessage(saveError, copy.errors.save, copy));
    } finally {
      setBusyAction(null);
    }
  };

  const syncManaged = async () => {
    if (!draft) return;
    setBusyAction('sync');
    setError(null);
    try {
      await syncManagedRuntimeCatalog({
        expectedRevision: draft.expectedRevision,
        setAsDefault: isOnboarding,
      });
      await loadCatalog();
      setMessage(copy.saved);
      onCatalogChanged?.();
    } catch (syncError) {
      setError(errorMessage(syncError, copy.errors.sync, copy));
    } finally {
      setBusyAction(null);
    }
  };

  if (loading && !data) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {copy.loading}
        </CardContent>
      </Card>
    );
  }

  if (!data || !draft) {
    return (
      <Card className={className}>
        <CardContent className="space-y-4 py-6">
          <p role="alert" className="text-sm text-destructive">{error || copy.errors.load}</p>
          <Button type="button" variant="outline" onClick={() => void loadCatalog()}>{copy.retry}</Button>
        </CardContent>
      </Card>
    );
  }

  const defaultDialogProvider = selectionProvider(draft.providers, defaultDraft);
  const defaultDialogModel = defaultDialogProvider && defaultDraft
    ? modelForProvider(defaultDialogProvider, defaultDraft.modelId)
    : undefined;
  const onboardingEndpoint = defaultProvider?.providerId === 'ollama'
    ? defaultProvider.config.ollamaHost?.trim() || defaultOllamaServerUrl()
    : defaultProvider?.providerId === 'openai-compatible'
      ? defaultProvider.config.openaiCompatibleBaseUrl?.trim() || copy.providerCard.endpointNotConfigured
      : defaultProvider
        ? copy.providerCard.source[defaultProvider.source]
        : copy.providerCard.endpointNotConfigured;

  if (isOnboarding) {
    const editableProvider = defaultProvider
      ?? draft.providers.find((provider) => provider.providerId !== CONTROL_PLANE_PROVIDER_ID);
    const openOnboardingSetup = () => {
      if (editableProvider) openProviderEditor(editableProvider);
      else openAddProvider();
    };

    return (
      <div className={cn('space-y-4', className)} data-testid="onboarding-provider-panel">
        {error && (
          <div role="alert" className="rounded-lg border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {message && (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            {message}
          </div>
        )}

        {onboardingConfigured && defaultProvider && defaultModel ? (
          <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/[0.055] via-background to-background py-0 shadow-sm">
            <div className="space-y-5 p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3.5">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                    <BrainCircuit className="size-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold">{defaultProvider.name}</h3>
                      <Badge variant={onboardingReady ? 'default' : 'secondary'}>
                        {copy.providerCard.status[defaultProvider.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                      {onboardingReady ? copy.onboardingReadyDescription : copy.onboardingNeedsReviewDescription}
                    </p>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => openProviderEditor(defaultProvider)}>
                  <Settings2 className="size-4" />
                  {copy.onboardingChange}
                </Button>
              </div>

              <dl className="grid gap-3 rounded-xl border bg-background/80 p-4 text-sm sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{copy.onboardingEndpoint}</dt>
                  <dd className="mt-1 truncate font-medium" title={onboardingEndpoint}>{onboardingEndpoint}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{copy.onboardingModel}</dt>
                  <dd className="mt-1 truncate font-medium" title={defaultModel.name}>{defaultModel.name}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{copy.onboardingScope}</dt>
                  <dd className="mt-1 truncate font-medium">{copy.providerCard.scope[defaultProvider.credentialScope]}</dd>
                </div>
              </dl>

              {addableProviders.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="px-0 text-muted-foreground" onClick={openAddProvider}>
                  <Plus className="size-4" />
                  {copy.onboardingUseOther}
                </Button>
              )}
            </div>
          </Card>
        ) : (
          <Card className="border-dashed py-0 shadow-none">
            <CardContent className="flex flex-col items-center px-5 py-10 text-center sm:px-8">
              <div className="flex size-12 items-center justify-center rounded-2xl border bg-muted/35 text-muted-foreground">
                <Server className="size-5" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{copy.onboardingEmptyTitle}</h3>
              <p className="mt-1 max-w-lg text-sm leading-relaxed text-muted-foreground">
                {copy.onboardingEmptyDescription}
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                {(editableProvider || addableProviders.length > 0) && (
                  <Button type="button" onClick={openOnboardingSetup}>
                    <Settings2 className="size-4" />
                    {copy.onboardingConfigure}
                  </Button>
                )}
                {showManagedSync && (
                  <Button type="button" variant="outline" disabled={busyAction !== null || (!managedDiscovered && !managedProvider)} onClick={() => void syncManaged()}>
                    {busyAction === 'sync' ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
                    {busyAction === 'sync' ? copy.managedSyncing : copy.managedSync}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <AiProviderEditorDialog
          open={editorOpen}
          provider={editorProvider}
          copy={copy.editor}
          locale={locale}
          isNew={editorIsNew}
          providerOptions={providerOptions}
          verificationOnly
          onNewProviderChange={changeNewProvider}
          onOpenChange={setEditorOpen}
          onSave={saveProvider}
        />
      </div>
    );
  }

  return (
    <div className={cn('space-y-6', className)}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl border bg-muted/35 text-muted-foreground">
              <BrainCircuit className="size-4.5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">{copy.title}</h1>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{copy.description}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={loading || busyAction !== null} onClick={() => void loadCatalog()}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {copy.reload}
        </Button>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          {message}
        </div>
      )}

      <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/[0.055] via-background to-background py-0 shadow-sm" data-testid="chat-default-card">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex min-w-0 items-start gap-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Settings2 className="size-4.5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{copy.defaultTitle}</h2>
                {defaultProvider && defaultModel && <Badge>{copy.defaultReady}</Badge>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{copy.defaultDescription}</p>
              <p className="mt-3 truncate text-sm font-medium">
                {defaultProvider && defaultModel
                  ? `${defaultProvider.name} · ${defaultModel.name} · ${copy.intelligenceLevel[draft.defaultSelection?.thinkingLevel ?? 'off']}`
                  : copy.defaultEmpty}
              </p>
            </div>
          </div>
          <Button type="button" variant="outline" disabled={selectableDefaultProviders.length === 0} onClick={openDefaultEditor}>
            <Settings2 className="size-4" />
            {copy.defaultEdit}
          </Button>
        </div>
      </Card>

      <section className="space-y-3" aria-labelledby="provider-overview-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h2 id="provider-overview-heading" className="text-base font-semibold">{copy.providersTitle}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{copy.providersDescription}</p>
          </div>
          <Button type="button" size="sm" disabled={addableProviders.length === 0 || busyAction !== null} onClick={openAddProvider}>
            <Plus className="size-4" />
            {copy.addProvider}
          </Button>
        </div>

        <div className="space-y-2.5">
          {showManagedSync && (
            <Card className="gap-0 overflow-hidden py-0 shadow-xs">
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl border bg-background text-muted-foreground">
                    <CloudDownload className="size-4.5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{copy.managedTitle}</h3>
                      <Badge variant={managedProvider?.status === 'ready' ? 'default' : 'secondary'}>
                        {managedProvider?.status === 'ready'
                          ? copy.managedReady
                          : managedDiscovered
                            ? copy.managedAvailable
                            : copy.managedUnavailable}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{copy.managedDescription}</p>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={busyAction !== null || (!managedDiscovered && !managedProvider)} onClick={() => void syncManaged()}>
                  {busyAction === 'sync' ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
                  {busyAction === 'sync' ? copy.managedSyncing : copy.managedSync}
                </Button>
              </div>
            </Card>
          )}

          {draft.providers.filter((provider) => provider.providerId !== CONTROL_PLANE_PROVIDER_ID).map((provider) => (
            <AiProviderCatalogCard
              key={provider.clientKey}
              provider={provider}
              appDefault={draft.defaultSelection}
              copy={copy.providerCard}
              disabled={busyAction !== null}
              onEdit={() => openProviderEditor(provider)}
            />
          ))}

          {draft.providers.filter((provider) => provider.providerId !== CONTROL_PLANE_PROVIDER_ID).length === 0 && !showManagedSync && (
            <Card className="border-dashed shadow-none">
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <Server className="size-6 text-muted-foreground" />
                <p className="text-sm font-medium">{copy.noProvidersTitle}</p>
                <p className="max-w-lg text-sm text-muted-foreground">{copy.noProvidersDescription}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
            <Info className="size-4" />
            {copy.setupDetails}
            <ChevronDown className="size-4" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="rounded-lg border bg-muted/15 p-4 text-sm leading-relaxed text-muted-foreground">
            {copy.setupDetailsDescription}
            {data.initialization?.issueCode && (
              <p className="mt-2">{copy.reviewIssue}: <code>{data.initialization.issueCode}</code></p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <AiProviderEditorDialog
        open={editorOpen}
        provider={editorProvider}
        copy={copy.editor}
        locale={locale}
        isNew={editorIsNew}
        providerOptions={providerOptions}
        onNewProviderChange={changeNewProvider}
        onOpenChange={setEditorOpen}
        onSave={saveProvider}
        onRemove={editorIsNew ? undefined : removeProvider}
      />

      <Dialog open={defaultOpen} onOpenChange={setDefaultOpen}>
        <DialogContent data-testid="chat-default-dialog">
          <DialogHeader>
            <DialogTitle>{copy.defaultDialogTitle}</DialogTitle>
            <DialogDescription>{copy.defaultDescription}</DialogDescription>
          </DialogHeader>
          {defaultDraft && defaultDialogProvider ? (
            <div className="grid gap-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="default-provider">{copy.defaultProvider}</Label>
                <select
                  id="default-provider"
                  value={defaultDialogProvider.clientKey}
                  onChange={(event) => {
                    const provider = draft.providers.find((candidate) => candidate.clientKey === event.target.value);
                    if (!provider) return;
                    const modelId = provider.modelIds.includes(provider.defaultModelId) ? provider.defaultModelId : provider.modelIds[0];
                    setDefaultDraft({
                      providerInstallationId: provider.providerInstallationId ?? '',
                      providerId: provider.providerId,
                      modelId,
                      thinkingLevel: 'off',
                    });
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {selectableDefaultProviders.map((provider) => (
                    <option key={provider.clientKey} value={provider.clientKey}>
                      {provider.name} · {copy.providerCard.scope[provider.credentialScope]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-model">{copy.defaultModel}</Label>
                <select
                  id="default-model"
                  value={defaultDraft.modelId}
                  onChange={(event) => {
                    const model = modelForProvider(defaultDialogProvider, event.target.value);
                    setDefaultDraft((current) => current ? {
                      ...current,
                      modelId: event.target.value,
                      thinkingLevel: model?.reasoning ? current.thinkingLevel : 'off',
                    } : current);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {defaultDialogProvider.availableModels
                    .filter((model) => defaultDialogProvider.modelIds.includes(model.id))
                    .map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-intelligence">{copy.intelligence}</Label>
                <select
                  id="default-intelligence"
                  value={defaultDraft.thinkingLevel}
                  disabled={!defaultDialogModel?.reasoning}
                  onChange={(event) => setDefaultDraft((current) => current ? {
                    ...current,
                    thinkingLevel: event.target.value as PiThinkingLevel,
                  } : current)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
                >
                  {(defaultDialogModel?.reasoning ? AI_THINKING_LEVELS : ['off'] as const)
                    .map((level) => <option key={level} value={level}>{copy.intelligenceLevel[level]}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.defaultEmpty}</p>
          )}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">{copy.cancel}</Button></DialogClose>
            <Button type="button" disabled={!defaultDraft || busyAction !== null} onClick={() => void saveDefault()}>
              {busyAction === 'default' && <Loader2 className="size-4 animate-spin" />}
              {copy.saveDefault}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
