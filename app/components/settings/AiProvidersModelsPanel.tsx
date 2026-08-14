'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
} from 'lucide-react';

import type {
  AiCatalogDiscoveryModel,
  AiCredentialScope,
  AiProviderSafeConfig,
  AiProviderSource,
  AiProviderStatus,
  AiRuntimeSelection,
} from '@/app/lib/agent-runtime-policy/types';
import {
  getAllowedCredentialScopesForProvider,
  validateProviderCatalogAuth,
} from '@/app/lib/agent-runtime-policy/provider-auth-policy';
import { AI_THINKING_LEVELS } from '@/app/lib/agent-runtime-policy/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { getAuthMethodForProvider } from '@/app/lib/pi/provider-help';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import {
  AiProviderCatalogCard,
  type AiProviderCatalogCardCopy,
} from './ai-runtime/AiProviderCatalogCard';
import { ProviderInstallationCredentialEditor } from './ProviderInstallationCredentialEditor';
import {
  catalogDataToDraft,
  readAdminRuntimeCatalog,
  RuntimeCatalogClientError,
  serializeCatalogDraft,
  syncManagedRuntimeCatalog,
  updateAdminRuntimeCatalog,
  verifyAdminProviderInstallation,
  type AdminRuntimeCatalogData,
  type AiCatalogProviderDraft,
  type AiRuntimeCatalogDraft,
} from './ai-runtime/catalog-client';

const CONTROL_PLANE_PROVIDER_ID = 'canvas-control-plane';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;

type DeploymentMode = 'managed' | 'self-hosted';
type SupportedLocale = 'de' | 'en';

type PanelCopy = {
  title: string;
  description: string;
  loading: string;
  retry: string;
  reload: string;
  discardReload: string;
  reset: string;
  save: string;
  saving: string;
  saved: string;
  verified: string;
  unsaved: string;
  savedState: string;
  setupComplete: string;
  setupIncomplete: string;
  currentDefault: (provider: string, model: string) => string;
  setupDetails: string;
  cancel: string;
  reviewIssue: string;
  secretNoticeTitle: string;
  secretNoticeDescription: string;
  managedTitle: string;
  managedDescription: string;
  managedReady: string;
  managedAvailable: string;
  managedUnavailable: string;
  managedLastSync: (value: string) => string;
  managedSetDefault: string;
  managedSetDefaultDescription: string;
  managedSync: string;
  managedSyncing: string;
  managedDirtyHint: string;
  providersTitle: string;
  providersDescription: string;
  noProvidersTitle: string;
  noProvidersDescription: string;
  addProviderTitle: string;
  addProviderDescription: string;
  provider: string;
  credentialScope: string;
  chooseProvider: string;
  addProvider: string;
  noProvidersAvailable: string;
  appDefaultTitle: string;
  appDefaultDescription: string;
  appDefaultProvider: string;
  appDefaultModel: string;
  intelligence: string;
  noDefaultAvailable: string;
  intelligenceLevel: Record<PiThinkingLevel, string>;
  providerCard: AiProviderCatalogCardCopy;
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
    appDefaultRequired: string;
    appDefaultAmbiguous: string;
    appDefaultInvalid: string;
    intelligenceInvalid: string;
  };
};

const SHARED_STATUS_DE: Record<AiProviderStatus, string> = {
  ready: 'Bereit',
  unverified: 'Nicht verifiziert',
  degraded: 'Beeinträchtigt',
  disabled: 'Deaktiviert',
};

const SHARED_STATUS_EN: Record<AiProviderStatus, string> = {
  ready: 'Ready',
  unverified: 'Unverified',
  degraded: 'Degraded',
  disabled: 'Disabled',
};

const SOURCE_DE: Record<AiProviderSource, string> = {
  managed: 'Control Plane',
  'built-in': 'Integriert',
  'self-hosted': 'Self-hosted',
};

const SOURCE_EN: Record<AiProviderSource, string> = {
  managed: 'Control Plane',
  'built-in': 'Built in',
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
  description: 'Lege fest, welche KI-Modelle in Canvas zur Verfügung stehen.',
  loading: 'KI-Katalog wird geladen …',
  retry: 'Erneut versuchen',
  reload: 'Neu laden',
  discardReload: 'Änderungen verwerfen & neu laden',
  reset: 'Zurücksetzen',
  save: 'Änderungen speichern',
  saving: 'Wird gespeichert …',
  saved: 'Die Änderungen wurden gespeichert.',
  verified: 'Die Provider-Installation wurde erfolgreich verifiziert.',
  unsaved: 'Nicht gespeicherte Änderungen',
  savedState: 'Alle Änderungen gespeichert',
  setupComplete: 'Bereit für neue Chats',
  setupIncomplete: 'Modell auswählen',
  currentDefault: (provider, model) => `${provider} · ${model}`,
  setupDetails: 'Informationen zur Einrichtung',
  cancel: 'Abbrechen',
  reviewIssue: 'Hinweiscode',
  secretNoticeTitle: 'Zugangsdaten bleiben zentral geschützt',
  secretNoticeDescription: 'API-Keys und OAuth-Verbindungen richtest du direkt in der jeweiligen Provider-Karte ein. Sie werden zentral im passenden Credential-Scope gespeichert; im Modellkatalog bleiben nur sichere Metadaten.',
  managedTitle: 'Canvas Control Plane',
  managedDescription: 'Synchronisiert die zentral freigegebenen Managed-Modelle und übernimmt auf Wunsch deren Standardmodell.',
  managedReady: 'Verbunden',
  managedAvailable: 'Verfügbar',
  managedUnavailable: 'Nicht verbunden',
  managedLastSync: (value) => `Zuletzt synchronisiert: ${value}`,
  managedSetDefault: 'Als App-Standard verwenden',
  managedSetDefaultDescription: 'Übernimmt beim Synchronisieren das Standardmodell der Control Plane.',
  managedSync: 'Managed-Katalog synchronisieren',
  managedSyncing: 'Synchronisiert …',
  managedDirtyHint: 'Speichere oder verwirf zuerst deine lokalen Änderungen.',
  providersTitle: 'KI-Provider',
  providersDescription: 'Verwalte die Anbieter und Modelle, die in Canvas verwendet werden dürfen.',
  noProvidersTitle: 'Noch keine Provider installiert',
  noProvidersDescription: 'Füge einen verfügbaren Provider hinzu oder synchronisiere eine verbundene Control Plane.',
  addProviderTitle: 'Provider hinzufügen',
  addProviderDescription: 'Wähle einen Anbieter aus. Danach öffnet sich seine Karte, in der du die Verbindung direkt einrichten kannst.',
  provider: 'Provider',
  credentialScope: 'Verfügbar für',
  chooseProvider: 'Provider auswählen',
  addProvider: 'Hinzufügen',
  noProvidersAvailable: 'Alle erkannten Provider sind bereits in ihren verfügbaren Credential-Scopes installiert.',
  appDefaultTitle: 'Standard für neue Chats',
  appDefaultDescription: 'Dieses Modell wird verwendet, wenn noch keine persönlichere Auswahl getroffen wurde.',
  appDefaultProvider: 'Standard-Provider',
  appDefaultModel: 'Standardmodell',
  intelligence: 'Intelligence',
  noDefaultAvailable: 'Aktiviere mindestens einen Provider und gib ein Modell frei, um einen App-Standard festzulegen.',
  intelligenceLevel: {
    off: 'Aus',
    minimal: 'Minimal',
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
    xhigh: 'Sehr hoch',
  },
  providerCard: {
    enabled: 'Aktiv',
    disabled: 'Inaktiv',
    remove: 'Entfernen',
    removeAria: 'Provider {provider} entfernen',
    verify: 'Verifizieren',
    verifying: 'Wird geprüft …',
    credentialScope: 'Verfügbar für',
    providerDefault: 'Standardmodell',
    appDefault: 'App-Standard',
    modelAllowlist: 'Freigegebene Modelle',
    modelAllowlistDescription: 'Nur diese Modelle können in Canvas verwendet werden.',
    selectedModels: (selected, total) => `${selected} von ${total} Modellen freigegeben`,
    configureModels: 'Konfigurieren',
    collapseModels: 'Schließen',
    searchModels: 'Modelle durchsuchen …',
    noModels: 'Für diesen Provider wurden keine Modelle erkannt.',
    noModelMatches: 'Keine passenden Modelle gefunden.',
    showAll: (count) => `${count} weitere Modelle anzeigen`,
    showLess: 'Weniger anzeigen',
    reasoning: 'Reasoning',
    vision: 'Vision',
    contextWindow: (tokens) => `${tokens} Kontext`,
    managedScopeLocked: 'Der Credential-Scope eines Managed Providers wird von der Control Plane vorgegeben.',
    oauthScopeLocked: 'OAuth-Verbindungen sind persönlich und werden deshalb immer pro Nutzer gespeichert.',
    authentication: 'Anmeldung',
    apiKeyAuthentication: 'API-Key',
    oauthAuthentication: 'Mit Konto anmelden (OAuth)',
    connection: 'Verbindung',
    connectionDescription: 'API-Key oder Konto-Zugang direkt für diesen Provider einrichten.',
    configureConnection: 'Einrichten',
    collapseConnection: 'Schließen',
    selfHostedConfiguration: 'Self-hosted Runtime',
    selfHostedDescription: 'Konfiguriere Endpoint und Modell-Metadaten. Den API-Key speicherst du direkt im Bereich „Verbindung“ dieser Karte.',
    openAiBaseUrl: 'OpenAI-kompatible Base URL',
    openAiBaseUrlPlaceholder: 'http://localhost:8080/v1',
    ollamaMode: 'Server-Modus',
    ollamaLocal: 'Lokal',
    ollamaRemote: 'Remote',
    ollamaLocalDescription: 'Verwendet http://localhost:11434/v1 innerhalb der App-Runtime.',
    ollamaRemoteHost: 'Remote Ollama URL',
    ollamaRemoteHostPlaceholder: 'https://ollama.example.com',
    modelSource: 'Modellquelle',
    predefinedModel: 'Vordefinierte Modelle',
    customModel: 'Eigenes Modell',
    customModelId: 'Custom Model ID',
    customModelPlaceholder: 'z. B. llama3.3:70b oder mein-modell',
    status: SHARED_STATUS_DE,
    source: SOURCE_DE,
    scope: SCOPE_DE,
  },
  errors: {
    load: 'Der KI-Katalog konnte nicht geladen werden.',
    save: 'Der KI-Katalog konnte nicht gespeichert werden.',
    sync: 'Der Managed-Katalog konnte nicht synchronisiert werden.',
    verify: 'Die Provider-Installation konnte nicht verifiziert werden.',
    revisionConflict: 'Der Katalog wurde zwischenzeitlich geändert. Lade die aktuelle Revision neu und prüfe deine Auswahl.',
    duplicateBinding: 'Diese Kombination aus Provider und Credential-Scope ist bereits vorhanden.',
    invalidAuthMethod: (provider) => `Die gewählte Authentifizierung wird von „${provider}“ nicht unterstützt.`,
    oauthScope: (provider) => `„${provider}“ verwendet persönliches OAuth und benötigt den Credential-Scope „Pro Nutzer“.`,
    openAiBaseUrl: 'Trage für den OpenAI-kompatiblen Provider eine gültige HTTP(S)-Base-URL ohne Zugangsdaten ein.',
    ollamaHost: 'Trage für den Remote-Ollama-Modus eine gültige HTTP(S)-URL ohne Zugangsdaten ein.',
    customModel: 'Trage eine gültige Custom Model ID ein.',
    enabledProviderModels: (provider) => `Der aktive Provider „${provider}“ benötigt mindestens ein freigegebenes Modell.`,
    providerDefault: (provider) => `Wähle für „${provider}“ ein freigegebenes Provider-Standardmodell.`,
    appDefaultRequired: 'Wähle einen App-Standard aus, bevor du den Katalog speicherst.',
    appDefaultAmbiguous: 'Speichere die neue Provider-Installation zuerst und wähle sie anschließend als App-Standard aus.',
    appDefaultInvalid: 'Der App-Standard muss auf einen aktiven Provider und ein freigegebenes Modell verweisen.',
    intelligenceInvalid: 'Die gewählte Intelligence-Stufe wird vom Standardmodell nicht unterstützt.',
  },
};

const EN_COPY: PanelCopy = {
  title: 'AI providers & models',
  description: 'Choose which AI models are available throughout Canvas.',
  loading: 'Loading AI catalog…',
  retry: 'Try again',
  reload: 'Reload',
  discardReload: 'Discard changes & reload',
  reset: 'Reset',
  save: 'Save changes',
  saving: 'Saving…',
  saved: 'The changes were saved.',
  verified: 'The provider installation was verified successfully.',
  unsaved: 'Unsaved changes',
  savedState: 'All changes saved',
  setupComplete: 'Ready for new chats',
  setupIncomplete: 'Choose a model',
  currentDefault: (provider, model) => `${provider} · ${model}`,
  setupDetails: 'Setup information',
  cancel: 'Cancel',
  reviewIssue: 'Issue code',
  secretNoticeTitle: 'Credentials stay centrally protected',
  secretNoticeDescription: 'Set up API keys and OAuth connections directly in each provider card. They are stored centrally in the appropriate credential scope; the model catalog contains safe metadata only.',
  managedTitle: 'Canvas Control Plane',
  managedDescription: 'Synchronizes centrally approved managed models and can adopt the Control Plane default model.',
  managedReady: 'Connected',
  managedAvailable: 'Available',
  managedUnavailable: 'Not connected',
  managedLastSync: (value) => `Last synchronized: ${value}`,
  managedSetDefault: 'Use as app default',
  managedSetDefaultDescription: 'Adopts the Control Plane default model during synchronization.',
  managedSync: 'Sync managed catalog',
  managedSyncing: 'Synchronizing…',
  managedDirtyHint: 'Save or discard your local changes first.',
  providersTitle: 'AI providers',
  providersDescription: 'Manage the providers and models that can be used in Canvas.',
  noProvidersTitle: 'No providers installed yet',
  noProvidersDescription: 'Add an available provider or synchronize a connected Control Plane.',
  addProviderTitle: 'Add provider',
  addProviderDescription: 'Choose a provider. Its card then opens so you can set up the connection right there.',
  provider: 'Provider',
  credentialScope: 'Available to',
  chooseProvider: 'Select a provider',
  addProvider: 'Add',
  noProvidersAvailable: 'All discovered providers are already installed in their available credential scopes.',
  appDefaultTitle: 'Default for new chats',
  appDefaultDescription: 'This model is used when no more personal selection has been made yet.',
  appDefaultProvider: 'Default provider',
  appDefaultModel: 'Default model',
  intelligence: 'Intelligence',
  noDefaultAvailable: 'Enable at least one provider and allow a model to configure an app default.',
  intelligenceLevel: {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
  },
  providerCard: {
    enabled: 'Active',
    disabled: 'Inactive',
    remove: 'Remove',
    removeAria: 'Remove provider {provider}',
    verify: 'Verify',
    verifying: 'Verifying…',
    credentialScope: 'Available to',
    providerDefault: 'Default model',
    appDefault: 'App default',
    modelAllowlist: 'Available models',
    modelAllowlistDescription: 'Only these models can be used in Canvas.',
    selectedModels: (selected, total) => `${selected} of ${total} models allowed`,
    configureModels: 'Configure',
    collapseModels: 'Close',
    searchModels: 'Search models…',
    noModels: 'No models were discovered for this provider.',
    noModelMatches: 'No matching models found.',
    showAll: (count) => `Show ${count} more models`,
    showLess: 'Show less',
    reasoning: 'Reasoning',
    vision: 'Vision',
    contextWindow: (tokens) => `${tokens} context`,
    managedScopeLocked: 'The credential scope of a managed provider is controlled by the Control Plane.',
    oauthScopeLocked: 'OAuth connections are personal, so their credentials are always stored per user.',
    authentication: 'Sign-in method',
    apiKeyAuthentication: 'API key',
    oauthAuthentication: 'Sign in with account (OAuth)',
    connection: 'Connection',
    connectionDescription: 'Set up this provider’s API key or account connection here.',
    configureConnection: 'Set up',
    collapseConnection: 'Close',
    selfHostedConfiguration: 'Self-hosted runtime',
    selfHostedDescription: 'Configure endpoint and model metadata here. Save the API key directly in this card’s Connection section.',
    openAiBaseUrl: 'OpenAI-compatible base URL',
    openAiBaseUrlPlaceholder: 'http://localhost:8080/v1',
    ollamaMode: 'Server mode',
    ollamaLocal: 'Local',
    ollamaRemote: 'Remote',
    ollamaLocalDescription: 'Uses http://localhost:11434/v1 from inside the app runtime.',
    ollamaRemoteHost: 'Remote Ollama URL',
    ollamaRemoteHostPlaceholder: 'https://ollama.example.com',
    modelSource: 'Model source',
    predefinedModel: 'Predefined models',
    customModel: 'Custom model',
    customModelId: 'Custom model ID',
    customModelPlaceholder: 'e.g. llama3.3:70b or my-model',
    status: SHARED_STATUS_EN,
    source: SOURCE_EN,
    scope: SCOPE_EN,
  },
  errors: {
    load: 'The AI catalog could not be loaded.',
    save: 'The AI catalog could not be saved.',
    sync: 'The managed catalog could not be synchronized.',
    verify: 'The provider installation could not be verified.',
    revisionConflict: 'The catalog changed in another session. Reload the current revision and review your choices.',
    duplicateBinding: 'This provider and credential scope combination already exists.',
    invalidAuthMethod: (provider) => `The selected authentication method is not supported by “${provider}”.`,
    oauthScope: (provider) => `“${provider}” uses personal OAuth and requires the “Per user” credential scope.`,
    openAiBaseUrl: 'Enter a valid HTTP(S) base URL without embedded credentials for the OpenAI-compatible provider.',
    ollamaHost: 'Enter a valid HTTP(S) URL without embedded credentials for remote Ollama mode.',
    customModel: 'Enter a valid custom model ID.',
    enabledProviderModels: (provider) => `The active provider “${provider}” needs at least one allowed model.`,
    providerDefault: (provider) => `Select an allowed provider default model for “${provider}”.`,
    appDefaultRequired: 'Select an app default before saving the catalog.',
    appDefaultAmbiguous: 'Save the new provider installation first, then select it as the app default.',
    appDefaultInvalid: 'The app default must reference an active provider and an allowed model.',
    intelligenceInvalid: 'The selected intelligence level is not supported by the default model.',
  },
};

export type AiProvidersModelsPanelProps = {
  locale?: string;
  deploymentMode?: DeploymentMode;
  className?: string;
  onCatalogChanged?: () => void;
};

function copyForLocale(locale: string | undefined): PanelCopy {
  return locale?.toLocaleLowerCase().startsWith('de') ? DE_COPY : EN_COPY;
}

function formatDate(value: string, locale: SupportedLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function selectClassName(): string {
  return 'h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';
}

function modelForProvider(provider: AiCatalogProviderDraft, modelId: string): AiCatalogDiscoveryModel | undefined {
  return provider.availableModels.find((model) => model.id === modelId);
}

function availableCredentialScopesForNewProvider(
  providers: readonly AiCatalogProviderDraft[],
  providerId: string,
): readonly AiCredentialScope[] {
  const configuredScopes = new Set(providers
    .filter((provider) => provider.providerId === providerId)
    .map((provider) => provider.credentialScope));
  return getAllowedCredentialScopesForProvider(providerId)
    .filter((credentialScope) => credentialScope !== 'managed' && !configuredScopes.has(credentialScope));
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

function configuredCustomModel(provider: AiCatalogProviderDraft): string | undefined {
  if (provider.providerId === 'openai-compatible') {
    return provider.config.openaiCompatibleCustomModel?.trim() || undefined;
  }
  if (provider.providerId === 'ollama' && provider.config.ollamaModelSource === 'custom') {
    return provider.config.ollamaCustomModel?.trim() || undefined;
  }
  return undefined;
}

function compactSafeConfig(config: AiProviderSafeConfig): AiProviderSafeConfig {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== '')) as AiProviderSafeConfig;
}

function customModelMetadata(modelId: string): AiCatalogDiscoveryModel {
  return {
    id: modelId,
    name: `${modelId} (Custom)`,
    reasoning: false,
    supportsVision: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function updateSelfHostedProviderConfig(params: {
  provider: AiCatalogProviderDraft;
  config: AiProviderSafeConfig;
  discoveredModels: readonly AiCatalogDiscoveryModel[];
}): AiCatalogProviderDraft {
  const previousCustomModel = configuredCustomModel(params.provider);
  const config = compactSafeConfig(params.config);
  const nextCustomModel = params.provider.providerId === 'openai-compatible'
    ? config.openaiCompatibleCustomModel?.trim()
    : config.ollamaModelSource === 'custom'
      ? config.ollamaCustomModel?.trim()
      : undefined;
  const nextCustomModelIsValid = Boolean(nextCustomModel && MODEL_ID_PATTERN.test(nextCustomModel));
  const baseModels = params.discoveredModels.filter((model) => model.id !== previousCustomModel);
  const availableModels = nextCustomModelIsValid && nextCustomModel
    ? [
        ...baseModels.filter((model) => model.id !== nextCustomModel),
        params.discoveredModels.find((model) => model.id === nextCustomModel) ?? customModelMetadata(nextCustomModel),
      ]
    : baseModels;
  const availableModelIds = new Set(availableModels.map((model) => model.id));
  let modelIds = params.provider.modelIds
    .filter((modelId) => modelId !== previousCustomModel && availableModelIds.has(modelId));
  if (nextCustomModelIsValid && nextCustomModel && !modelIds.includes(nextCustomModel)) {
    modelIds = [...modelIds, nextCustomModel];
  }
  if (
    params.provider.providerId === 'ollama'
    && params.provider.config.ollamaModelSource === 'custom'
    && config.ollamaModelSource === 'predefined'
    && modelIds.length === 0
    && availableModels[0]
  ) {
    modelIds = [availableModels[0].id];
  }
  const defaultModelId = modelIds.includes(params.provider.defaultModelId)
    ? params.provider.defaultModelId
    : modelIds[0] ?? '';

  return {
    ...params.provider,
    config,
    modelIds,
    defaultModelId,
    availableModels: availableModels.sort((left, right) => left.name.localeCompare(right.name)),
    status: params.provider.enabled ? 'unverified' : 'disabled',
  };
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

function defaultSelectionForProviders(
  providers: readonly AiCatalogProviderDraft[],
  current: AiRuntimeSelection | null,
): AiRuntimeSelection | null {
  const currentProvider = selectionProvider(providers, current);
  if (
    current
    && currentProvider?.enabled
    && currentProvider.modelIds.includes(current.modelId)
  ) {
    const model = modelForProvider(currentProvider, current.modelId);
    return {
      ...current,
      thinkingLevel: model?.reasoning ? current.thinkingLevel : 'off',
    };
  }

  const provider = providers.find((candidate) => candidate.enabled && candidate.modelIds.length > 0);
  if (!provider) return null;
  const modelId = provider.modelIds.includes(provider.defaultModelId)
    ? provider.defaultModelId
    : provider.modelIds[0];
  return {
    providerInstallationId: provider.providerInstallationId ?? '',
    providerId: provider.providerId,
    modelId,
    thinkingLevel: 'off',
  };
}

function withSuggestedDefaultSelection(draft: AiRuntimeCatalogDraft): AiRuntimeCatalogDraft {
  return {
    ...draft,
    defaultSelection: defaultSelectionForProviders(draft.providers, draft.defaultSelection),
  };
}

function validateDraft(draft: AiRuntimeCatalogDraft, copy: PanelCopy): string | null {
  const bindings = new Set<string>();
  for (const provider of draft.providers) {
    const binding = `${provider.providerId}\0${provider.credentialScope}`;
    if (bindings.has(binding)) return copy.errors.duplicateBinding;
    bindings.add(binding);
    const authIssue = validateProviderCatalogAuth(provider);
    if (authIssue === 'INVALID_PROVIDER_AUTH_METHOD') {
      return copy.errors.invalidAuthMethod(provider.name);
    }
    if (authIssue === 'OAUTH_REQUIRES_USER_SCOPE') {
      return copy.errors.oauthScope(provider.name);
    }
    if (provider.providerId === 'openai-compatible') {
      const baseUrl = provider.config.openaiCompatibleBaseUrl;
      if ((provider.enabled || baseUrl) && !isSafeEndpoint(baseUrl)) return copy.errors.openAiBaseUrl;
      const customModel = provider.config.openaiCompatibleCustomModel?.trim();
      if ((provider.enabled || customModel) && (!customModel || !MODEL_ID_PATTERN.test(customModel))) {
        return copy.errors.customModel;
      }
    }
    if (provider.providerId === 'ollama') {
      const host = provider.config.ollamaHost;
      if (provider.config.ollamaMode === 'cloud' && (provider.enabled || host) && !isSafeEndpoint(host)) {
        return copy.errors.ollamaHost;
      }
      if (provider.config.ollamaModelSource === 'custom') {
        const customModel = provider.config.ollamaCustomModel?.trim();
        if ((provider.enabled || customModel) && (!customModel || !MODEL_ID_PATTERN.test(customModel))) {
          return copy.errors.customModel;
        }
      }
    }
    if (provider.enabled && provider.modelIds.length === 0) {
      return copy.errors.enabledProviderModels(provider.name);
    }
    if (provider.modelIds.length > 0 && !provider.modelIds.includes(provider.defaultModelId)) {
      return copy.errors.providerDefault(provider.name);
    }
  }

  const enabledProviders = draft.providers.filter((provider) => provider.enabled && provider.modelIds.length > 0);
  if (enabledProviders.length === 0) return null;
  if (!draft.defaultSelection) return copy.errors.appDefaultRequired;
  const provider = selectionProvider(draft.providers, draft.defaultSelection);
  if (!provider && !draft.defaultSelection.providerInstallationId) {
    return copy.errors.appDefaultAmbiguous;
  }
  if (!provider?.enabled || !provider.modelIds.includes(draft.defaultSelection.modelId)) {
    return copy.errors.appDefaultInvalid;
  }
  const model = modelForProvider(provider, draft.defaultSelection.modelId);
  if (!model?.reasoning && draft.defaultSelection.thinkingLevel !== 'off') {
    return copy.errors.intelligenceInvalid;
  }
  return null;
}

function errorMessage(error: unknown, fallback: string, copy: PanelCopy): string {
  if (error instanceof RuntimeCatalogClientError) {
    if (error.code === 'CATALOG_REVISION_CONFLICT') return copy.errors.revisionConflict;
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function AiProvidersModelsPanel({
  locale,
  deploymentMode,
  className,
  onCatalogChanged,
}: AiProvidersModelsPanelProps) {
  const copy = copyForLocale(locale);
  const resolvedLocale: SupportedLocale = locale?.toLocaleLowerCase().startsWith('de') ? 'de' : 'en';
  const [data, setData] = useState<AdminRuntimeCatalogData | null>(null);
  const [draft, setDraft] = useState<AiRuntimeCatalogDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [verifyingInstallationId, setVerifyingInstallationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isAddProviderDialogOpen, setIsAddProviderDialogOpen] = useState(false);
  const [addProviderId, setAddProviderId] = useState('');
  const [addCredentialScope, setAddCredentialScope] = useState<AiCredentialScope>('organization');
  const [connectionOpenProviderClientKey, setConnectionOpenProviderClientKey] = useState<string | null>(null);
  const [setManagedAsDefault, setSetManagedAsDefault] = useState(true);

  const applyCatalogData = useCallback((nextData: AdminRuntimeCatalogData) => {
    const storedDraft = catalogDataToDraft(nextData);
    const nextDraft = withSuggestedDefaultSelection(storedDraft);
    setData(nextData);
    setDraft(nextDraft);
    // A migrated/self-hosted catalog can contain valid providers but no app
    // default yet. Suggest the first valid default and keep the stored null as
    // the baseline so the admin can actually save the required review.
    setBaseline(serializeCatalogDraft(storedDraft));
    setSetManagedAsDefault(
      !nextData.catalog.defaultSelection
      || nextData.catalog.defaultSelection.providerId === CONTROL_PLANE_PROVIDER_ID,
    );
  }, []);

  const loadCatalog = useCallback(async (showLoading = true) => {
    if (showLoading) setIsLoading(true);
    setError(null);
    try {
      const nextData = await readAdminRuntimeCatalog();
      applyCatalogData(nextData);
      setMessage(null);
    } catch (loadError) {
      setError(errorMessage(loadError, copy.errors.load, copy));
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [applyCatalogData, copy]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCatalog();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadCatalog]);

  const isDirty = useMemo(() => (
    draft ? serializeCatalogDraft(draft) !== baseline : false
  ), [baseline, draft]);

  const managedProvider = draft?.providers.find((provider) => provider.providerId === CONTROL_PLANE_PROVIDER_ID);
  const managedDiscovered = Boolean(data?.discovery[CONTROL_PLANE_PROVIDER_ID]);
  const resolvedDeploymentMode: DeploymentMode = deploymentMode
    ?? (managedProvider || managedDiscovered ? 'managed' : 'self-hosted');
  const showManagedSync = resolvedDeploymentMode === 'managed' || Boolean(managedProvider) || managedDiscovered;

  const addableProviders = useMemo(() => {
    if (!data || !draft) return [];
    return Object.values(data.discovery)
      .filter((provider) => (
        provider.id !== CONTROL_PLANE_PROVIDER_ID
        && availableCredentialScopesForNewProvider(draft.providers, provider.id).length > 0
      ))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [data, draft]);
  const resolvedAddProviderId = addableProviders.some((provider) => provider.id === addProviderId)
    ? addProviderId
    : addableProviders[0]?.id ?? '';
  const addableCredentialScopes = draft && resolvedAddProviderId
    ? availableCredentialScopesForNewProvider(draft.providers, resolvedAddProviderId)
    : [];
  const resolvedAddCredentialScope = addableCredentialScopes.includes(addCredentialScope)
    ? addCredentialScope
    : addableCredentialScopes[0];

  const openAddProviderDialog = () => {
    const providerId = addableProviders[0]?.id ?? '';
    setAddProviderId(providerId);
    if (draft && providerId) {
      setAddCredentialScope(availableCredentialScopesForNewProvider(draft.providers, providerId)[0] ?? 'organization');
    }
    setIsAddProviderDialogOpen(true);
  };

  const defaultProvider = draft ? selectionProvider(draft.providers, draft.defaultSelection) : undefined;
  const defaultModel = defaultProvider && draft?.defaultSelection
    ? modelForProvider(defaultProvider, draft.defaultSelection.modelId)
    : undefined;
  const selectableDefaultProviders = draft?.providers.filter((provider) => (
    provider.enabled && provider.modelIds.length > 0
  )) ?? [];
  const hasDefault = Boolean(defaultProvider && defaultModel && draft?.defaultSelection);

  const updateProviders = (updater: (providers: AiCatalogProviderDraft[]) => AiCatalogProviderDraft[]) => {
    setDraft((current) => {
      if (!current) return current;
      const providers = updater(current.providers);
      return {
        ...current,
        providers,
        defaultSelection: defaultSelectionForProviders(providers, current.defaultSelection),
      };
    });
    setError(null);
    setMessage(null);
  };

  const updateProvider = (
    clientKey: string,
    updater: (provider: AiCatalogProviderDraft) => AiCatalogProviderDraft,
  ) => updateProviders((providers) => providers.map((provider) => (
    provider.clientKey === clientKey ? updater(provider) : provider
  )));

  const addProvider = () => {
    if (!draft || !data || !resolvedAddProviderId || !resolvedAddCredentialScope) return;
    const discovered = data.discovery[resolvedAddProviderId];
    if (!discovered) return;
    const firstModel = discovered.models[0];
    const isOpenAiCompatible = discovered.id === 'openai-compatible';
    const isOllama = discovered.id === 'ollama';
    const isOAuth = getAuthMethodForProvider(discovered.id) === 'oauth';
    const clientKey = `new-${discovered.id}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const provider: AiCatalogProviderDraft = {
      clientKey,
      providerId: discovered.id,
      name: discovered.name,
      source: discovered.source,
      status: 'unverified',
      enabled: Boolean(firstModel) && !isOpenAiCompatible,
      credentialScope: resolvedAddCredentialScope,
      providerInstallationId: discovered.installationIds?.[resolvedAddCredentialScope],
      config: isOAuth
        ? { authMethod: 'oauth' }
        : isOpenAiCompatible
        ? { openaiCompatibleModelSource: 'custom' }
        : isOllama
          ? { ollamaMode: 'local', ollamaModelSource: 'predefined' }
          : {},
      modelIds: firstModel ? [firstModel.id] : [],
      defaultModelId: firstModel?.id ?? '',
      availableModels: [...discovered.models].sort((left, right) => left.name.localeCompare(right.name)),
      sourceRevision: null,
      lastSyncedAt: null,
    };
    updateProviders((providers) => [...providers, provider]);
    setConnectionOpenProviderClientKey(clientKey);
    setAddProviderId('');
    setIsAddProviderDialogOpen(false);
  };

  const saveCatalog = async () => {
    if (!draft) return;
    const validationError = validateDraft(draft, copy);
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const nextData = await updateAdminRuntimeCatalog(draft);
      applyCatalogData({
        ...nextData,
        initialization: { action: 'existing', issueCode: null },
      });
      setMessage(copy.saved);
      onCatalogChanged?.();
    } catch (saveError) {
      setError(errorMessage(saveError, copy.errors.save, copy));
    } finally {
      setIsSaving(false);
    }
  };

  const syncManagedCatalog = async () => {
    if (!draft || isDirty) return;
    setIsSyncing(true);
    setError(null);
    setMessage(null);
    try {
      await syncManagedRuntimeCatalog({
        expectedRevision: draft.expectedRevision,
        setAsDefault: setManagedAsDefault,
      });
      await loadCatalog(false);
      setMessage(copy.saved);
      onCatalogChanged?.();
    } catch (syncError) {
      setError(errorMessage(syncError, copy.errors.sync, copy));
    } finally {
      setIsSyncing(false);
    }
  };

  const verifyProvider = async (providerInstallationId: string) => {
    if (isDirty || verifyingInstallationId) return;
    setVerifyingInstallationId(providerInstallationId);
    setError(null);
    setMessage(null);
    try {
      await verifyAdminProviderInstallation(providerInstallationId);
      await loadCatalog(false);
      setMessage(copy.verified);
      onCatalogChanged?.();
    } catch (verifyError) {
      setError(errorMessage(verifyError, copy.errors.verify, copy));
    } finally {
      setVerifyingInstallationId(null);
    }
  };

  if (isLoading && !data) {
    return <AiProvidersModelsPanelSkeleton label={copy.loading} className={className} />;
  }

  if (!data || !draft) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error || copy.errors.load}</span>
          </div>
          <Button type="button" variant="outline" onClick={() => void loadCatalog()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {copy.retry}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const busy = isSaving || isSyncing || verifyingInstallationId !== null;

  return (
    <div className={cn('space-y-4', className)}>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-4 py-5 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground shadow-xs">
                <BrainCircuit className="size-5" aria-hidden="true" />
              </div>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-lg">{copy.title}</CardTitle>
                  {isDirty && <Badge variant="secondary">{copy.unsaved}</Badge>}
                </div>
                <CardDescription className="max-w-3xl leading-relaxed">{copy.description}</CardDescription>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || isLoading}
              onClick={() => void loadCatalog()}
            >
              {isLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {isDirty ? copy.discardReload : copy.reload}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{copy.appDefaultTitle}</p>
              <p className="text-sm text-muted-foreground">
                {hasDefault && defaultProvider && defaultModel
                  ? copy.currentDefault(defaultProvider.name, defaultModel.name)
                  : copy.noDefaultAvailable}
              </p>
            </div>
            <Badge variant={hasDefault && !isDirty ? 'default' : 'secondary'}>
              {isDirty ? copy.unsaved : hasDefault ? copy.setupComplete : copy.setupIncomplete}
            </Badge>
          </div>

          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
                <LockKeyhole className="size-4" aria-hidden="true" />
                {copy.setupDetails}
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                <div className="flex items-start gap-3">
                  <LockKeyhole className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{copy.secretNoticeTitle}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{copy.secretNoticeDescription}</p>
                  </div>
                </div>
                {data.initialization?.issueCode && (
                  <div role="status" className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm text-amber-950 dark:text-amber-100">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                    <span>{copy.reviewIssue}:</span>
                    <code className="rounded bg-background px-1.5 py-0.5 text-xs">{data.initialization.issueCode}</code>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {error && (
            <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          {message && (
            <div role="status" aria-live="polite" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-900 dark:text-emerald-100">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{message}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {showManagedSync && (
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="border-b px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-xs">
                  <CloudDownload className="size-4" aria-hidden="true" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{copy.managedTitle}</CardTitle>
                    <Badge variant={managedProvider?.status === 'ready' ? 'default' : managedDiscovered ? 'secondary' : 'outline'}>
                      {managedProvider?.status === 'ready'
                        ? copy.managedReady
                        : managedDiscovered
                          ? copy.managedAvailable
                          : copy.managedUnavailable}
                    </Badge>
                  </div>
                  <CardDescription>{copy.managedDescription}</CardDescription>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={busy || isDirty || (!managedDiscovered && !managedProvider)}
                onClick={() => void syncManagedCatalog()}
              >
                {isSyncing ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
                {isSyncing ? copy.managedSyncing : copy.managedSync}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-4 py-3 sm:px-6">
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
                  {copy.setupDetails}
                  <ChevronDown className="size-4" aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{copy.managedSetDefault}</p>
                    <p className="text-xs text-muted-foreground">{copy.managedSetDefaultDescription}</p>
                    {managedProvider?.lastSyncedAt && (
                      <p className="text-xs text-muted-foreground">
                        {copy.managedLastSync(formatDate(managedProvider.lastSyncedAt, resolvedLocale))}
                      </p>
                    )}
                    {isDirty && <p className="text-xs text-amber-700 dark:text-amber-300">{copy.managedDirtyHint}</p>}
                  </div>
                  <Switch
                    checked={setManagedAsDefault}
                    disabled={busy}
                    onCheckedChange={setSetManagedAsDefault}
                    aria-label={copy.managedSetDefault}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="ai-providers-heading">
        <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h2 id="ai-providers-heading" className="text-sm font-semibold">{copy.providersTitle}</h2>
            <p className="text-sm text-muted-foreground">{copy.providersDescription}</p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy || addableProviders.length === 0}
            onClick={openAddProviderDialog}
          >
            <Plus className="size-4" aria-hidden="true" />
            {copy.addProvider}
          </Button>
        </div>

        {draft.providers.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-2 xl:items-start">
            {draft.providers.map((provider) => (
              <AiProviderCatalogCard
                key={provider.clientKey}
                provider={provider}
                appDefault={draft.defaultSelection}
                copy={copy.providerCard}
                disabled={busy}
                verifying={verifyingInstallationId === provider.providerInstallationId}
                initialCredentialsOpen={provider.clientKey === connectionOpenProviderClientKey}
                credentialEditor={(
                  <ProviderInstallationCredentialEditor
                    installation={{
                      installationId: provider.providerInstallationId ?? provider.clientKey,
                      providerId: provider.providerId,
                      name: provider.name,
                      credentialScope: provider.credentialScope,
                      authMethod: provider.config.authMethod,
                    }}
                    locale={locale}
                    showIdentity={false}
                    onCredentialsSaved={() => void saveCatalog()}
                  />
                )}
                onVerify={provider.providerInstallationId && !isDirty
                  ? () => void verifyProvider(provider.providerInstallationId!)
                  : undefined}
                onEnabledChange={(enabled) => updateProvider(provider.clientKey, (current) => ({
                  ...current,
                  enabled,
                  status: enabled
                    ? (current.status === 'disabled' ? 'unverified' : current.status)
                    : 'disabled',
                }))}
                onCredentialScopeChange={(credentialScope) => {
                  const duplicate = draft.providers.some((candidate) => (
                    candidate.clientKey !== provider.clientKey
                    && candidate.providerId === provider.providerId
                    && candidate.credentialScope === credentialScope
                  ));
                  if (duplicate) {
                    setError(copy.errors.duplicateBinding);
                    return;
                  }
                  updateProvider(provider.clientKey, (current) => ({
                    ...current,
                    providerInstallationId: data.discovery[current.providerId]?.installationIds?.[credentialScope],
                    credentialScope,
                    status: current.enabled ? 'unverified' : 'disabled',
                  }));
                }}
                onAuthMethodChange={(authMethod) => {
                  const credentialScopes = getAllowedCredentialScopesForProvider(provider.providerId, authMethod);
                  const credentialScope = credentialScopes.includes(provider.credentialScope)
                    ? provider.credentialScope
                    : credentialScopes[0];
                  const duplicate = draft.providers.some((candidate) => (
                    candidate.clientKey !== provider.clientKey
                    && candidate.providerId === provider.providerId
                    && candidate.credentialScope === credentialScope
                  ));
                  if (duplicate) {
                    setError(copy.errors.duplicateBinding);
                    return;
                  }
                  updateProvider(provider.clientKey, (current) => ({
                    ...current,
                    credentialScope,
                    providerInstallationId: data.discovery[current.providerId]?.installationIds?.[credentialScope],
                    config: { ...current.config, authMethod },
                    status: current.enabled ? 'unverified' : 'disabled',
                  }));
                }}
                onConfigChange={(config) => updateProvider(provider.clientKey, (current) => (
                  updateSelfHostedProviderConfig({
                    provider: current,
                    config,
                    discoveredModels: data.discovery[current.providerId]?.models ?? current.availableModels,
                  })
                ))}
                onCustomModelChange={(modelId) => updateProvider(provider.clientKey, (current) => {
                  const config: AiProviderSafeConfig = current.providerId === 'openai-compatible'
                    ? {
                        ...current.config,
                        openaiCompatibleModelSource: 'custom',
                        openaiCompatibleCustomModel: modelId || undefined,
                      }
                    : {
                        ...current.config,
                        ollamaModelSource: 'custom',
                        ollamaCustomModel: modelId || undefined,
                      };
                  return updateSelfHostedProviderConfig({
                    provider: current,
                    config,
                    discoveredModels: data.discovery[current.providerId]?.models ?? current.availableModels,
                  });
                })}
                onModelAllowedChange={(model, allowed) => updateProvider(provider.clientKey, (current) => {
                  const modelIds = allowed
                    ? current.availableModels.filter((candidate) => (
                        candidate.id === model.id || current.modelIds.includes(candidate.id)
                      )).map((candidate) => candidate.id)
                    : current.modelIds.filter((modelId) => modelId !== model.id);
                  const defaultModelId = modelIds.includes(current.defaultModelId)
                    ? current.defaultModelId
                    : modelIds[0] ?? '';
                  return { ...current, modelIds, defaultModelId };
                })}
                onProviderDefaultChange={(model) => updateProvider(provider.clientKey, (current) => ({
                  ...current,
                  defaultModelId: model.id,
                }))}
                onRemove={() => updateProviders((providers) => providers.filter((candidate) => (
                  candidate.clientKey !== provider.clientKey
                )))}
              />
            ))}
          </div>
        ) : (
          <Card className="border-dashed shadow-none">
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Server className="size-6 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">{copy.noProvidersTitle}</p>
              <p className="max-w-lg text-sm text-muted-foreground">{copy.noProvidersDescription}</p>
              {addableProviders.length === 0 && (
                <p className="max-w-lg text-xs text-muted-foreground">{copy.noProvidersAvailable}</p>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      <Dialog open={isAddProviderDialogOpen} onOpenChange={setIsAddProviderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.addProviderTitle}</DialogTitle>
            <DialogDescription>{copy.addProviderDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="ai-catalog-add-provider">{copy.provider}</Label>
              <div className="relative">
                <select
                  id="ai-catalog-add-provider"
                  value={resolvedAddProviderId}
                  disabled={busy || addableProviders.length === 0}
                  onChange={(event) => {
                    const providerId = event.target.value;
                    setAddProviderId(providerId);
                    const availableScopes = availableCredentialScopesForNewProvider(draft.providers, providerId);
                    setAddCredentialScope((current) => (
                      availableScopes.includes(current) ? current : availableScopes[0] ?? 'organization'
                    ));
                  }}
                  className={selectClassName()}
                >
                  <option value="" disabled>
                    {addableProviders.length > 0 ? copy.chooseProvider : copy.noProvidersAvailable}
                  </option>
                  {addableProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-catalog-add-scope">{copy.credentialScope}</Label>
              <div className="relative">
                <select
                  id="ai-catalog-add-scope"
                  value={resolvedAddCredentialScope ?? ''}
                  disabled={busy || addableCredentialScopes.length === 0}
                  onChange={(event) => setAddCredentialScope(event.target.value as AiCredentialScope)}
                  className={selectClassName()}
                >
                  {addableCredentialScopes.map((scope) => (
                    <option key={scope} value={scope}>{copy.providerCard.scope[scope]}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{copy.cancel}</Button>
            </DialogClose>
            <Button
              type="button"
              disabled={busy || !resolvedAddProviderId || !resolvedAddCredentialScope}
              onClick={addProvider}
            >
              <Plus className="size-4" aria-hidden="true" />
              {copy.addProvider}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
          <CardHeader className="px-4 sm:px-6">
            <div className="flex items-center gap-2">
              <BrainCircuit className="size-5 text-muted-foreground" aria-hidden="true" />
              <CardTitle>{copy.appDefaultTitle}</CardTitle>
            </div>
            <CardDescription>{copy.appDefaultDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-4 sm:px-6">
            {selectableDefaultProviders.length > 0 && defaultProvider && draft.defaultSelection ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="ai-catalog-default-provider">{copy.appDefaultProvider}</Label>
                  <div className="relative">
                    <select
                      id="ai-catalog-default-provider"
                      value={defaultProvider.clientKey}
                      disabled={busy}
                      onChange={(event) => {
                        const provider = draft.providers.find((candidate) => candidate.clientKey === event.target.value);
                        if (!provider) return;
                        const modelId = provider.modelIds.includes(provider.defaultModelId)
                          ? provider.defaultModelId
                          : provider.modelIds[0];
                        setDraft((current) => current ? {
                          ...current,
                          defaultSelection: {
                            providerInstallationId: provider.providerInstallationId ?? '',
                            providerId: provider.providerId,
                            modelId,
                            thinkingLevel: 'off',
                          },
                        } : current);
                        setMessage(null);
                        setError(null);
                      }}
                      className={selectClassName()}
                    >
                      {selectableDefaultProviders.map((provider) => (
                        <option key={provider.clientKey} value={provider.clientKey}>
                          {provider.name} · {copy.providerCard.scope[provider.credentialScope]}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ai-catalog-default-model">{copy.appDefaultModel}</Label>
                  <div className="relative">
                    <select
                      id="ai-catalog-default-model"
                      value={draft.defaultSelection.modelId}
                      disabled={busy}
                      onChange={(event) => {
                        const model = modelForProvider(defaultProvider, event.target.value);
                        setDraft((current) => current?.defaultSelection ? {
                          ...current,
                          defaultSelection: {
                            ...current.defaultSelection,
                            modelId: event.target.value,
                            thinkingLevel: model?.reasoning ? current.defaultSelection.thinkingLevel : 'off',
                          },
                        } : current);
                        setMessage(null);
                        setError(null);
                      }}
                      className={selectClassName()}
                    >
                      {defaultProvider.availableModels.filter((model) => defaultProvider.modelIds.includes(model.id)).map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ai-catalog-default-intelligence">{copy.intelligence}</Label>
                  <div className="relative">
                    <select
                      id="ai-catalog-default-intelligence"
                      value={draft.defaultSelection.thinkingLevel}
                      disabled={busy || !defaultModel?.reasoning}
                      onChange={(event) => {
                        setDraft((current) => current?.defaultSelection ? {
                          ...current,
                          defaultSelection: {
                            ...current.defaultSelection,
                            thinkingLevel: event.target.value as PiThinkingLevel,
                          },
                        } : current);
                        setMessage(null);
                        setError(null);
                      }}
                      className={selectClassName()}
                    >
                      {(defaultModel?.reasoning ? AI_THINKING_LEVELS : ['off'] as const).map((level) => (
                        <option key={level} value={level}>{copy.intelligenceLevel[level]}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  </div>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{copy.noDefaultAvailable}</p>
            )}
          </CardContent>
      </Card>

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm text-muted-foreground">
          {isDirty ? copy.unsaved : copy.savedState}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || !isDirty}
            onClick={() => {
              const nextDraft = withSuggestedDefaultSelection(catalogDataToDraft(data));
              setDraft(nextDraft);
              setError(null);
              setMessage(null);
            }}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {copy.reset}
          </Button>
          <Button type="button" disabled={busy || !isDirty} onClick={() => void saveCatalog()}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {isSaving ? copy.saving : copy.save}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AiProvidersModelsPanelSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn('space-y-4', className)} aria-busy="true" aria-label={label}>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-52" />
              <Skeleton className="h-4 max-w-2xl" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-8 w-48" />
        </CardContent>
      </Card>
      <div className="grid gap-3 xl:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
