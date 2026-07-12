'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  BrainCircuit,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Cpu,
  FolderKanban,
  KeyRound,
  Layers3,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  UserRound,
} from 'lucide-react';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { ProviderInstallationCredentialEditor } from '@/app/components/settings/ProviderInstallationCredentialEditor';
import type {
  AiCatalogModel,
  AiEffectiveCatalogProvider,
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
} from '@/app/lib/agent-runtime-policy/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type WorkspaceItem = {
  id: string;
  type: 'personal' | 'organization' | 'team' | 'project';
  name: string;
  organizationId?: string | null;
  status: string;
  isDefault: boolean;
  permissions: {
    canRead: boolean;
    canRunAgent: boolean;
  };
};

type AgentItem = {
  agentId: string;
  name: string;
  iconId?: string | null;
  type: string;
};

type WorkspacesResponse = {
  success: boolean;
  activeWorkspaceId?: string | null;
  defaultWorkspace?: WorkspaceItem | null;
  workspaces?: WorkspaceItem[];
  error?: string;
  code?: string;
};

type AgentsResponse = {
  success: boolean;
  data?: { agents?: AgentItem[] };
  error?: string;
  code?: string;
};

type RuntimeResponse = {
  success: boolean;
  data?: AiEffectiveRuntimeResolution;
  error?: string;
  code?: string;
};

type MutationKind = 'save' | 'reset' | null;

type PanelCopy = {
  source: Record<AiRuntimeSelectionSource, string>;
  workspaceType: Record<WorkspaceItem['type'], string>;
  intelligenceLevel: Record<string, string>;
  providerStatus: Record<string, string>;
  credentialScope: Record<string, string>;
  loadingAria: string;
  selectionSummary: {
    providerInstallation: string;
    model: string;
    intelligence: string;
    unavailable: string;
  };
  errors: {
    loadWorkspaces: string;
    loadAgents: string;
    loadContexts: string;
    loadPreference: string;
    savePreference: string;
    missingSavedPreference: string;
    resetPreference: string;
    missingInheritedSelection: string;
  };
  saveSuccess: string;
  resetSuccess: string;
  header: {
    settings: string;
    runtime: string;
    title: string;
    description: string;
    reload: string;
  };
  context: {
    section: string;
    loadFailed: string;
    retry: string;
    workspace: string;
    selectWorkspace: string;
    agentUnavailable: string;
    workspaceAccess: string;
    agent: string;
    selectAgent: string;
    separatePreference: string;
  };
  effective: {
    section: string;
    noModel: string;
    resolvedFrom: (source: string) => string;
    unresolvedDescription: string;
    catalogRevision: (revision: number) => string;
    policyRevision: (revision: number) => string;
    valid: string;
    actionRequired: string;
    issuesAria: string;
    cannotRun: string;
    unavailable: string;
  };
  preference: {
    section: string;
    providerInstallation: string;
    selectProvider: string;
    unavailable: string;
    providerHelp: string;
    model: string;
    selectModel: string;
    installation: string;
    credentialScope: string;
    readiness: string;
    credentialAvailable: string;
    credentialMissing: string;
    intelligence: string;
    intelligenceHelp: string;
    useInherited: string;
    save: string;
  };
  credentials: {
    section: string;
    title: string;
    description: string;
    missing: string;
  };
  summary: {
    aria: string;
    effectiveTitle: string;
    effectiveDescription: string;
    inheritedTitle: string;
    inheritedDescription: string;
    policyTitle: string;
    policyDescription: string;
  };
  empty: {
    title: string;
    description: string;
  };
};

const DE_COPY: PanelCopy = {
  source: {
    session: 'Sitzungsauswahl',
    user_preference: 'Meine Präferenz',
    agent_default: 'Agent-Standard',
    workspace_default: 'Workspace-Standard',
    app_default: 'App-Standard',
  },
  workspaceType: {
    personal: 'Persönlicher Workspace',
    organization: 'Organisations-Workspace',
    team: 'Team-Workspace',
    project: 'Projekt-Workspace',
  },
  intelligenceLevel: {
    off: 'Aus',
    minimal: 'Minimal',
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
    xhigh: 'Sehr hoch',
  },
  providerStatus: {
    ready: 'Bereit',
    degraded: 'Beeinträchtigt',
    unverified: 'Nicht verifiziert',
    disabled: 'Deaktiviert',
  },
  credentialScope: {
    managed: 'Von der Control Plane verwaltet',
    system: 'App-Zugangsdaten',
    organization: 'Organisations-Zugangsdaten',
    user: 'Persönliche Zugangsdaten',
  },
  loadingAria: 'KI-Runtime-Präferenzen werden geladen',
  selectionSummary: {
    providerInstallation: 'Provider-Installation',
    model: 'Modell',
    intelligence: 'Intelligence',
    unavailable: 'Es ist keine Runtime-Auswahl verfügbar.',
  },
  errors: {
    loadWorkspaces: 'Die Workspaces konnten nicht geladen werden.',
    loadAgents: 'Die Agents konnten nicht geladen werden.',
    loadContexts: 'Die Runtime-Kontexte konnten nicht geladen werden.',
    loadPreference: 'Deine KI-Runtime-Präferenz konnte nicht geladen werden.',
    savePreference: 'Deine KI-Runtime-Präferenz konnte nicht gespeichert werden.',
    missingSavedPreference: 'Der Server hat keine Runtime-Präferenz zurückgegeben.',
    resetPreference: 'Deine KI-Runtime-Präferenz konnte nicht zurückgesetzt werden.',
    missingInheritedSelection: 'Der Server hat keine geerbte Runtime-Auswahl zurückgegeben.',
  },
  saveSuccess: 'Deine Runtime-Präferenz wurde gespeichert.',
  resetSuccess: 'Deine Präferenz wurde auf den geerbten Standard zurückgesetzt.',
  header: {
    settings: 'Meine Einstellungen',
    runtime: 'Agent-Runtime',
    title: 'Meine Agent-Runtime',
    description: 'Wähle für jeden Workspace und Agent eine freigegebene Provider-Installation und ein Modell. App- und Workspace-Richtlinien bleiben immer maßgeblich.',
    reload: 'Neu laden',
  },
  context: {
    section: 'Runtime-Kontext',
    loadFailed: 'Runtime-Kontexte konnten nicht geladen werden',
    retry: 'Erneut versuchen',
    workspace: 'Workspace',
    selectWorkspace: 'Workspace auswählen',
    agentUnavailable: 'Agent nicht verfügbar',
    workspaceAccess: 'Der Zugriff wird für diesen Workspace geprüft, bevor Modelle geladen werden.',
    agent: 'Agent',
    selectAgent: 'Agent auswählen',
    separatePreference: 'Präferenzen werden für diesen Agent separat gespeichert.',
  },
  effective: {
    section: 'Effektive Runtime',
    noModel: 'Kein Modell ausgewählt',
    resolvedFrom: (source) => `Für den gewählten Kontext aus „${source}“ aufgelöst.`,
    unresolvedDescription: 'Für diesen Kontext ist noch kein gültiger Runtime-Standard festgelegt.',
    catalogRevision: (revision) => `Katalog r${revision}`,
    policyRevision: (revision) => `Richtlinie r${revision}`,
    valid: 'Gültig',
    actionRequired: 'Aktion erforderlich',
    issuesAria: 'Probleme mit der Runtime-Richtlinie',
    cannotRun: 'Diese Auswahl kann noch nicht ausgeführt werden',
    unavailable: 'Runtime-Präferenz nicht verfügbar',
  },
  preference: {
    section: 'Meine Präferenz',
    providerInstallation: 'Provider-Installation',
    selectProvider: 'Freigegebenen Provider auswählen',
    unavailable: 'Nicht verfügbar',
    providerHelp: 'Aufgeführt werden nur Installationen, die von App- und Workspace-Richtlinie freigegeben sind.',
    model: 'Modell',
    selectModel: 'Modell auswählen',
    installation: 'Installation',
    credentialScope: 'Credential-Scope',
    readiness: 'Bereitschaft',
    credentialAvailable: 'Zugangsdaten verfügbar',
    credentialMissing: 'Zugangsdaten fehlen',
    intelligence: 'Intelligence',
    intelligenceHelp: 'Die verfügbaren Stufen stammen aus dem gewählten Modell. Ein Modellwechsel kann diese Auswahl verändern.',
    useInherited: 'Geerbten Standard verwenden',
    save: 'Meine Präferenz speichern',
  },
  credentials: {
    section: 'Persönlicher Provider-Zugang',
    title: 'Meine Zugangsdaten',
    description: 'Diese Installation verwendet deinen persönlichen Secret-Scope. Hinterlege hier den API-Key oder verbinde dein OAuth-Konto.',
    missing: 'Für diese Installation fehlen noch persönliche Zugangsdaten. Nach dem Speichern wird die Runtime-Auswahl automatisch neu geprüft.',
  },
  summary: {
    aria: 'Zusammenfassung der Runtime-Auswahl',
    effectiveTitle: 'Jetzt effektiv',
    effectiveDescription: 'Diese Auswahl wird in diesem Kontext für neue Sitzungen verwendet.',
    inheritedTitle: 'Geerbter Standard',
    inheritedDescription: 'Wird verwendet, wenn du deine persönliche Präferenz entfernst.',
    policyTitle: 'Durch Richtlinien geschützt',
    policyDescription: 'Deine Präferenz speichert nur Modellkennungen und Revisionen. Provider-Zugangsdaten und Secrets werden hier niemals angezeigt.',
  },
  empty: {
    title: 'Kein Runtime-Kontext verfügbar',
    description: 'Du benötigst mindestens einen Agent-fähigen Workspace und ein Agent-Profil.',
  },
};

const EN_COPY: PanelCopy = {
  source: {
    session: 'Session selection',
    user_preference: 'My preference',
    agent_default: 'Agent default',
    workspace_default: 'Workspace default',
    app_default: 'App default',
  },
  workspaceType: {
    personal: 'Personal workspace',
    organization: 'Organization workspace',
    team: 'Team workspace',
    project: 'Project workspace',
  },
  intelligenceLevel: {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
  },
  providerStatus: {
    ready: 'Ready',
    degraded: 'Degraded',
    unverified: 'Unverified',
    disabled: 'Disabled',
  },
  credentialScope: {
    managed: 'Control Plane managed',
    system: 'App credential',
    organization: 'Organization credential',
    user: 'Personal credential',
  },
  loadingAria: 'Loading AI runtime preferences',
  selectionSummary: {
    providerInstallation: 'Provider installation',
    model: 'Model',
    intelligence: 'Intelligence',
    unavailable: 'No runtime selection is available.',
  },
  errors: {
    loadWorkspaces: 'Could not load workspaces.',
    loadAgents: 'Could not load agents.',
    loadContexts: 'Could not load runtime contexts.',
    loadPreference: 'Could not load your AI runtime preference.',
    savePreference: 'Could not save your AI runtime preference.',
    missingSavedPreference: 'The server returned no runtime preference.',
    resetPreference: 'Could not reset your AI runtime preference.',
    missingInheritedSelection: 'The server returned no inherited runtime selection.',
  },
  saveSuccess: 'Your runtime preference was saved.',
  resetSuccess: 'Your preference was reset to the inherited default.',
  header: {
    settings: 'My settings',
    runtime: 'Agent runtime',
    title: 'My agent runtime',
    description: 'Choose an approved provider installation and model for each workspace and agent. App and workspace policy always remain authoritative.',
    reload: 'Reload',
  },
  context: {
    section: 'Runtime context',
    loadFailed: 'Runtime contexts could not be loaded',
    retry: 'Try again',
    workspace: 'Workspace',
    selectWorkspace: 'Select a workspace',
    agentUnavailable: 'Agent unavailable',
    workspaceAccess: 'Access is checked against this workspace before models are loaded.',
    agent: 'Agent',
    selectAgent: 'Select an agent',
    separatePreference: 'Preferences are stored separately for this agent.',
  },
  effective: {
    section: 'Effective runtime',
    noModel: 'No model selected',
    resolvedFrom: (source) => `Resolved from ${source.toLocaleLowerCase()} for the selected context.`,
    unresolvedDescription: 'No valid runtime default has been configured for this context yet.',
    catalogRevision: (revision) => `Catalog r${revision}`,
    policyRevision: (revision) => `Policy r${revision}`,
    valid: 'Valid',
    actionRequired: 'Action required',
    issuesAria: 'Runtime policy issues',
    cannotRun: 'This selection cannot run yet',
    unavailable: 'Runtime preference unavailable',
  },
  preference: {
    section: 'My preference',
    providerInstallation: 'Provider installation',
    selectProvider: 'Select an approved provider',
    unavailable: 'Unavailable',
    providerHelp: 'Only installations allowed by the app and workspace policy are listed.',
    model: 'Model',
    selectModel: 'Select a model',
    installation: 'Installation',
    credentialScope: 'Credential scope',
    readiness: 'Readiness',
    credentialAvailable: 'Credential available',
    credentialMissing: 'Credential missing',
    intelligence: 'Intelligence',
    intelligenceHelp: 'Available levels come from the selected model; changing the model can change this list.',
    useInherited: 'Use inherited default',
    save: 'Save my preference',
  },
  credentials: {
    section: 'Personal provider access',
    title: 'My credentials',
    description: 'This installation uses your personal secret scope. Add your API key or connect your OAuth account here.',
    missing: 'This installation still needs personal credentials. The runtime selection will be checked again automatically after saving.',
  },
  summary: {
    aria: 'Runtime selection summary',
    effectiveTitle: 'Effective now',
    effectiveDescription: 'The selection that new sessions will use in this context.',
    inheritedTitle: 'Inherited default',
    inheritedDescription: 'Used when you remove your personal preference.',
    policyTitle: 'Policy protected',
    policyDescription: 'Your preference stores model identifiers and revisions only. Provider credentials and secrets are never shown here.',
  },
  empty: {
    title: 'No runtime context is available',
    description: 'You need at least one agent-enabled workspace and one agent profile.',
  },
};

export type MyAgentRuntimePanelProps = {
  locale?: string;
  onPreferenceSaved?: (context: { workspaceId: string; agentId: string }) => void;
};

function copyForLocale(locale: string | undefined): PanelCopy {
  return locale?.toLocaleLowerCase().startsWith('de') ? DE_COPY : EN_COPY;
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as { error?: unknown; code?: unknown };
    if (typeof value.error === 'string' && value.error.trim()) {
      return value.error.trim();
    }
    if (typeof value.code === 'string' && value.code.trim()) {
      return value.code.trim();
    }
  }
  return fallback;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || !payload || (typeof payload === 'object' && 'success' in payload && payload.success !== true)) {
    throw new Error(getErrorMessage(payload, fallback));
  }
  return payload;
}

function sourceLabel(source: AiRuntimeSelectionSource | null, copy: PanelCopy): string {
  return source ? copy.source[source] : copy.effective.unavailable;
}

function sameSelection(left: AiRuntimeSelection | null, right: AiRuntimeSelection | null): boolean {
  if (!left || !right) return left === right;
  return left.providerInstallationId === right.providerInstallationId
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.thinkingLevel === right.thinkingLevel;
}

function firstSelectableSelection(resolution: AiEffectiveRuntimeResolution): AiRuntimeSelection | null {
  const provider = resolution.providers.find((candidate) => candidate.selectable);
  const model = provider?.models.find((candidate) => candidate.enabled);
  if (!provider || !model) return null;
  const thinkingLevel = model.thinkingLevels.includes('off')
    ? 'off'
    : model.thinkingLevels[0];
  if (!thinkingLevel) return null;
  return {
    providerInstallationId: provider.installationId,
    providerId: provider.providerId,
    modelId: model.id,
    thinkingLevel,
  };
}

function initialDraft(resolution: AiEffectiveRuntimeResolution): AiRuntimeSelection | null {
  return resolution.preference?.selection
    ?? resolution.effectiveSelection?.selection
    ?? resolution.inheritedSelection?.selection
    ?? firstSelectableSelection(resolution);
}

function providerForSelection(
  resolution: AiEffectiveRuntimeResolution | null,
  selection: AiRuntimeSelection | null | undefined,
): AiEffectiveCatalogProvider | null {
  if (!resolution || !selection) return null;
  return resolution.providers.find(
    (provider) => provider.installationId === selection.providerInstallationId,
  ) ?? null;
}

function canPrepareProvider(provider: AiEffectiveCatalogProvider): boolean {
  return provider.selectable
    || (provider.credentialScope === 'user' && provider.status === 'ready');
}

function modelForSelection(
  provider: AiEffectiveCatalogProvider | null,
  selection: AiRuntimeSelection | null | undefined,
): AiCatalogModel | null {
  if (!provider || !selection) return null;
  return provider.models.find((model) => model.id === selection.modelId) ?? null;
}

function preferredThinkingLevel(model: AiCatalogModel, current?: string | null) {
  if (current && model.thinkingLevels.includes(current as AiRuntimeSelection['thinkingLevel'])) {
    return current as AiRuntimeSelection['thinkingLevel'];
  }
  if (model.thinkingLevels.includes('off')) return 'off';
  return model.thinkingLevels[0] ?? 'off';
}

function WorkspaceIcon({ type, className }: { type: WorkspaceItem['type']; className?: string }) {
  if (type === 'personal') return <UserRound className={className} aria-hidden="true" />;
  if (type === 'project') return <FolderKanban className={className} aria-hidden="true" />;
  return <Building2 className={className} aria-hidden="true" />;
}

function RuntimeLoadingState({ copy }: { copy: PanelCopy }) {
  return (
    <Card aria-label={copy.loadingAria} aria-busy="true">
      <CardHeader className="px-4 sm:px-6">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </CardHeader>
      <CardContent className="space-y-5 px-4 sm:px-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-32 w-full" />
      </CardContent>
    </Card>
  );
}

function SelectionSummary({
  title,
  description,
  resolution,
  selection,
  source,
  subdued = false,
  copy,
}: {
  title: string;
  description: string;
  resolution: AiEffectiveRuntimeResolution;
  selection: AiRuntimeSelection | null | undefined;
  source: AiRuntimeSelectionSource | null;
  subdued?: boolean;
  copy: PanelCopy;
}) {
  const provider = providerForSelection(resolution, selection);
  const model = modelForSelection(provider, selection);

  return (
    <div className={cn(
      'min-w-0 rounded-lg border p-4',
      subdued ? 'bg-muted/20' : 'bg-background shadow-sm',
    )}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline" className="shrink-0 whitespace-nowrap">
          {sourceLabel(source, copy)}
        </Badge>
      </div>

      {selection ? (
        <dl className="mt-4 grid min-w-0 gap-3 text-sm">
          <div className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.selectionSummary.providerInstallation}</dt>
            <dd className="mt-1 min-w-0">
              <span className="block truncate font-medium" title={provider?.name || selection.providerId}>
                {provider?.name || selection.providerId}
              </span>
              <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
                {selection.providerInstallationId}
              </span>
            </dd>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.selectionSummary.model}</dt>
              <dd className="mt-1 break-words font-medium">{model?.name || selection.modelId}</dd>
              {model?.name && model.name !== selection.modelId && (
                <dd className="break-all font-mono text-[11px] text-muted-foreground">{selection.modelId}</dd>
              )}
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.selectionSummary.intelligence}</dt>
              <dd className="mt-1 font-medium">{copy.intelligenceLevel[selection.thinkingLevel] || selection.thinkingLevel}</dd>
            </div>
          </div>
        </dl>
      ) : (
        <div className="mt-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {copy.selectionSummary.unavailable}
        </div>
      )}
    </div>
  );
}

export function MyAgentRuntimePanel({ locale, onPreferenceSaved }: MyAgentRuntimePanelProps = {}) {
  const copy = copyForLocale(locale);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<AiEffectiveRuntimeResolution | null>(null);
  const [resolutionLoading, setResolutionLoading] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiRuntimeSelection | null>(null);
  const [mutation, setMutation] = useState<MutationKind>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [resolutionReloadKey, setResolutionReloadKey] = useState(0);
  const sourcesRequestRef = useRef(0);
  const resolutionRequestRef = useRef(0);
  const credentialRefreshRef = useRef<{
    workspaceId: string;
    agentId: string;
    selection: AiRuntimeSelection;
  } | null>(null);

  const loadSources = useCallback(async () => {
    const requestId = ++sourcesRequestRef.current;
    setSourcesLoading(true);
    setSourcesError(null);
    setNotice(null);

    try {
      const [workspaceResponse, agentResponse] = await Promise.all([
        fetch('/api/workspaces', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' }),
      ]);
      const [workspacePayload, agentPayload] = await Promise.all([
        readJson<WorkspacesResponse>(workspaceResponse, copy.errors.loadWorkspaces),
        readJson<AgentsResponse>(agentResponse, copy.errors.loadAgents),
      ]);
      if (requestId !== sourcesRequestRef.current) return;

      const nextWorkspaces = workspacePayload.workspaces ?? [];
      const nextAgents = agentPayload.data?.agents ?? [];
      const runnableWorkspaces = nextWorkspaces.filter(
        (workspace) => workspace.status === 'active'
          && workspace.permissions.canRead
          && workspace.permissions.canRunAgent,
      );
      const preferredWorkspaceId = workspacePayload.activeWorkspaceId
        ?? workspacePayload.defaultWorkspace?.id
        ?? runnableWorkspaces[0]?.id
        ?? '';
      const preferredAgentId = nextAgents.find((agent) => agent.agentId === 'canvas-agent')?.agentId
        ?? nextAgents[0]?.agentId
        ?? '';

      setWorkspaces(nextWorkspaces);
      setAgents(nextAgents);
      setSelectedWorkspaceId((current) => (
        runnableWorkspaces.some((workspace) => workspace.id === current)
          ? current
          : runnableWorkspaces.some((workspace) => workspace.id === preferredWorkspaceId)
            ? preferredWorkspaceId
            : runnableWorkspaces[0]?.id ?? ''
      ));
      setSelectedAgentId((current) => (
        nextAgents.some((agent) => agent.agentId === current) ? current : preferredAgentId
      ));
      setResolutionReloadKey((current) => current + 1);
    } catch (error) {
      if (requestId !== sourcesRequestRef.current) return;
      setSourcesError(error instanceof Error ? error.message : copy.errors.loadContexts);
    } finally {
      if (requestId === sourcesRequestRef.current) setSourcesLoading(false);
    }
  }, [copy.errors.loadAgents, copy.errors.loadContexts, copy.errors.loadWorkspaces]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadSources();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      sourcesRequestRef.current += 1;
      resolutionRequestRef.current += 1;
    };
  }, [loadSources]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedAgentId) return;

    const requestId = ++resolutionRequestRef.current;
    const timeoutId = window.setTimeout(() => {
      if (requestId !== resolutionRequestRef.current) return;
      setResolutionLoading(true);
      setResolutionError(null);
      setResolution(null);
      setDraft(null);
      setNotice(null);

      const query = new URLSearchParams({
        workspaceId: selectedWorkspaceId,
        agentId: selectedAgentId,
      });
      void fetch(`/api/agent-runtime/preferences?${query.toString()}`, { cache: 'no-store' })
        .then((response) => readJson<RuntimeResponse>(response, copy.errors.loadPreference))
        .then((payload) => {
          if (requestId !== resolutionRequestRef.current || !payload.data) return;
          const pendingCredentialRefresh = credentialRefreshRef.current;
          credentialRefreshRef.current = null;
          setResolution(payload.data);
          if (
            pendingCredentialRefresh
            && pendingCredentialRefresh.workspaceId === selectedWorkspaceId
            && pendingCredentialRefresh.agentId === selectedAgentId
          ) {
            const pendingProvider = providerForSelection(payload.data, pendingCredentialRefresh.selection);
            const pendingModel = modelForSelection(pendingProvider, pendingCredentialRefresh.selection);
            setDraft(pendingProvider && pendingModel
              ? {
                  ...pendingCredentialRefresh.selection,
                  thinkingLevel: preferredThinkingLevel(
                    pendingModel,
                    pendingCredentialRefresh.selection.thinkingLevel,
                  ),
                }
              : initialDraft(payload.data));
          } else {
            setDraft(initialDraft(payload.data));
          }
          if (payload.data.preference && payload.data.valid) {
            onPreferenceSaved?.({ workspaceId: selectedWorkspaceId, agentId: selectedAgentId });
          }
        })
        .catch((error: unknown) => {
          if (requestId !== resolutionRequestRef.current) return;
          setResolutionError(error instanceof Error ? error.message : copy.errors.loadPreference);
        })
        .finally(() => {
          if (requestId === resolutionRequestRef.current) setResolutionLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      if (resolutionRequestRef.current === requestId) {
        resolutionRequestRef.current += 1;
      }
    };
  }, [copy.errors.loadPreference, onPreferenceSaved, resolutionReloadKey, selectedAgentId, selectedWorkspaceId]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );
  const selectedProvider = useMemo(
    () => providerForSelection(resolution, draft),
    [draft, resolution],
  );
  const selectedModel = useMemo(
    () => modelForSelection(selectedProvider, draft),
    [draft, selectedProvider],
  );
  const effectiveSelection = resolution?.effectiveSelection?.selection ?? null;
  const effectiveProvider = useMemo(
    () => providerForSelection(resolution, effectiveSelection),
    [effectiveSelection, resolution],
  );
  const effectiveModel = useMemo(
    () => modelForSelection(effectiveProvider, effectiveSelection),
    [effectiveProvider, effectiveSelection],
  );
  const currentPreference = resolution?.preference?.selection ?? null;
  const draftIsDirty = Boolean(draft) && !sameSelection(draft, currentPreference);
  const draftIsSelectable = Boolean(
    draft
      && selectedProvider?.selectable
      && selectedModel?.enabled
      && selectedModel.thinkingLevels.includes(draft.thinkingLevel),
  );
  const controlsDisabled = sourcesLoading || resolutionLoading || mutation !== null;

  const applyRuntimeResponse = (next: AiEffectiveRuntimeResolution) => {
    setResolution(next);
    setDraft(initialDraft(next));
    setResolutionError(null);
  };

  const handleProviderChange = (installationId: string) => {
    if (!resolution) return;
    const provider = resolution.providers.find((candidate) => candidate.installationId === installationId);
    const model = provider?.models.find((candidate) => candidate.enabled);
    if (!provider || !model) return;
    setDraft({
      providerInstallationId: provider.installationId,
      providerId: provider.providerId,
      modelId: model.id,
      thinkingLevel: preferredThinkingLevel(model, draft?.thinkingLevel),
    });
    setNotice(null);
  };

  const handleModelChange = (modelId: string) => {
    if (!selectedProvider) return;
    const model = selectedProvider.models.find((candidate) => candidate.id === modelId);
    if (!model) return;
    setDraft({
      providerInstallationId: selectedProvider.installationId,
      providerId: selectedProvider.providerId,
      modelId: model.id,
      thinkingLevel: preferredThinkingLevel(model, draft?.thinkingLevel),
    });
    setNotice(null);
  };

  const handleCredentialsSaved = () => {
    if (draft) {
      credentialRefreshRef.current = {
        workspaceId: selectedWorkspaceId,
        agentId: selectedAgentId,
        selection: { ...draft },
      };
    }
    setNotice(null);
    setResolutionReloadKey((current) => current + 1);
  };

  const handleSave = async () => {
    if (!resolution || !draft || !draftIsSelectable || mutation) return;
    setMutation('save');
    setNotice(null);

    try {
      const response = await fetch('/api/agent-runtime/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          agentId: selectedAgentId,
          expectedRevision: resolution.preference?.revision ?? 0,
          expectedCatalogRevision: resolution.catalogRevision,
          expectedPolicyRevision: resolution.policyRevision,
          selection: draft,
        }),
      });
      const payload = await readJson<RuntimeResponse>(response, copy.errors.savePreference);
      if (!payload.data) throw new Error(copy.errors.missingSavedPreference);
      applyRuntimeResponse(payload.data);
      setNotice({ tone: 'success', message: copy.saveSuccess });
      onPreferenceSaved?.({ workspaceId: selectedWorkspaceId, agentId: selectedAgentId });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : copy.errors.savePreference,
      });
    } finally {
      setMutation(null);
    }
  };

  const handleReset = async () => {
    if (!resolution?.preference || mutation) return;
    setMutation('reset');
    setNotice(null);

    try {
      const query = new URLSearchParams({
        workspaceId: selectedWorkspaceId,
        agentId: selectedAgentId,
        expectedRevision: String(resolution.preference.revision),
      });
      const response = await fetch(`/api/agent-runtime/preferences?${query.toString()}`, {
        method: 'DELETE',
      });
      const payload = await readJson<RuntimeResponse>(response, copy.errors.resetPreference);
      if (!payload.data) throw new Error(copy.errors.missingInheritedSelection);
      applyRuntimeResponse(payload.data);
      setNotice({ tone: 'success', message: copy.resetSuccess });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : copy.errors.resetPreference,
      });
    } finally {
      setMutation(null);
    }
  };

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="my-agent-runtime-title">
      <Card className="min-w-0 overflow-hidden border-t-2 border-t-primary/70">
        <CardHeader className="border-b bg-muted/20 px-4 sm:px-6">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-background shadow-sm">
                <BrainCircuit className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  <span>{copy.header.settings}</span>
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  <span>{copy.header.runtime}</span>
                </div>
                <CardTitle id="my-agent-runtime-title" className="text-lg">{copy.header.title}</CardTitle>
                <CardDescription className="mt-1 max-w-2xl leading-5">
                  {copy.header.description}
                </CardDescription>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadSources()}
              disabled={controlsDisabled}
              className="w-full sm:w-auto"
            >
              {sourcesLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {copy.header.reload}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 px-4 sm:px-6">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <span className="flex h-5 w-5 items-center justify-center rounded-full border bg-muted text-[10px]">01</span>
            {copy.context.section}
          </div>

          {sourcesError ? (
            <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
              <div className="flex min-w-0 items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-destructive">{copy.context.loadFailed}</p>
                  <p className="mt-1 break-words text-sm text-muted-foreground">{sourcesError}</p>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadSources()}>
                <RefreshCw />
                {copy.context.retry}
              </Button>
            </div>
          ) : (
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <label htmlFor="my-runtime-workspace" className="flex items-center gap-2 text-sm font-medium">
                  {selectedWorkspace
                    ? <WorkspaceIcon type={selectedWorkspace.type} className="h-4 w-4 text-muted-foreground" />
                    : <Layers3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                  {copy.context.workspace}
                </label>
                <select
                  id="my-runtime-workspace"
                  className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  value={selectedWorkspaceId}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                  disabled={controlsDisabled || workspaces.length === 0}
                >
                  <option value="" disabled>{copy.context.selectWorkspace}</option>
                  {workspaces.map((workspace) => {
                    const runnable = workspace.status === 'active'
                      && workspace.permissions.canRead
                      && workspace.permissions.canRunAgent;
                    return (
                      <option key={workspace.id} value={workspace.id} disabled={!runnable}>
                        {workspace.name} · {copy.workspaceType[workspace.type]}
                        {!runnable ? ` · ${copy.context.agentUnavailable}` : ''}
                      </option>
                    );
                  })}
                </select>
                {selectedWorkspace && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.context.workspaceAccess}
                  </p>
                )}
              </div>

              <div className="min-w-0 space-y-2">
                <label htmlFor="my-runtime-agent" className="flex items-center gap-2 text-sm font-medium">
                  <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {copy.context.agent}
                </label>
                <select
                  id="my-runtime-agent"
                  className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  value={selectedAgentId}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                  disabled={controlsDisabled || agents.length === 0}
                >
                  <option value="" disabled>{copy.context.selectAgent}</option>
                  {agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.name} · {agent.agentId}
                    </option>
                  ))}
                </select>
                {selectedAgent && (
                  <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <AgentAvatar iconId={selectedAgent.iconId} className="h-5 w-5 rounded" iconClassName="h-3 w-3" />
                    <span className="truncate">{copy.context.separatePreference}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {resolutionLoading && <RuntimeLoadingState copy={copy} />}

      {!resolutionLoading && resolutionError && (
        <Card className="border-destructive/30" role="alert">
          <CardContent className="flex flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{copy.effective.unavailable}</p>
                <p className="mt-1 break-words text-sm text-muted-foreground">{resolutionError}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setResolutionReloadKey((current) => current + 1)}
            >
              <RefreshCw />
              {copy.context.retry}
            </Button>
          </CardContent>
        </Card>
      )}

      {!resolutionLoading && resolution && (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b px-4 sm:px-6">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border bg-muted text-[10px]">02</span>
                  {copy.effective.section}
                </div>
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <Cpu className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{effectiveModel?.name || effectiveSelection?.modelId || copy.effective.noModel}</span>
                </CardTitle>
                <CardDescription className="mt-1">
                  {resolution.source
                    ? copy.effective.resolvedFrom(sourceLabel(resolution.source, copy))
                    : copy.effective.unresolvedDescription}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="gap-1.5">
                  <Layers3 className="h-3 w-3" aria-hidden="true" />
                  {copy.effective.catalogRevision(resolution.catalogRevision)}
                </Badge>
                <Badge variant="outline">{copy.effective.policyRevision(resolution.policyRevision)}</Badge>
                <Badge
                  variant={resolution.valid ? 'default' : 'destructive'}
                  className="gap-1.5"
                >
                  {resolution.valid
                    ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    : <AlertCircle className="h-3 w-3" aria-hidden="true" />}
                  {resolution.valid ? copy.effective.valid : copy.effective.actionRequired}
                </Badge>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-6 px-4 sm:px-6">
            {resolution.issues.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4" role="alert" aria-label={copy.effective.issuesAria}>
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{copy.effective.cannotRun}</p>
                    <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                      {resolution.issues.map((issue, index) => (
                        <li key={`${issue.code}-${index}`} className="min-w-0">
                          <span className="font-mono text-[11px] text-destructive">{issue.code}</span>
                          <span className="mx-2 text-border" aria-hidden="true">/</span>
                          <span className="break-words">{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.42fr)]">
              <div className="min-w-0 space-y-5">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border bg-muted text-[10px]">03</span>
                  {copy.preference.section}
                </div>

                <div className="grid min-w-0 gap-4 md:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <label htmlFor="my-runtime-provider" className="flex items-center gap-2 text-sm font-medium">
                      <Server className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      {copy.preference.providerInstallation}
                    </label>
                    <select
                      id="my-runtime-provider"
                      className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                      value={draft?.providerInstallationId ?? ''}
                      onChange={(event) => handleProviderChange(event.target.value)}
                      disabled={controlsDisabled || resolution.providers.length === 0}
                      aria-describedby="my-runtime-provider-help"
                    >
                      <option value="" disabled>{copy.preference.selectProvider}</option>
                      {draft && !selectedProvider && (
                        <option value={draft.providerInstallationId} disabled>
                          {copy.preference.unavailable} · {draft.providerId}
                        </option>
                      )}
                      {resolution.providers.map((provider) => (
                        <option
                          key={provider.installationId}
                          value={provider.installationId}
                          disabled={!canPrepareProvider(provider)}
                        >
                          {provider.name} · {copy.credentialScope[provider.credentialScope] || provider.credentialScope}
                          {!provider.selectable ? ` · ${copy.providerStatus[provider.status] || provider.status}` : ''}
                        </option>
                      ))}
                    </select>
                    <p id="my-runtime-provider-help" className="text-xs leading-5 text-muted-foreground">
                      {copy.preference.providerHelp}
                    </p>
                  </div>

                  <div className="min-w-0 space-y-2">
                    <label htmlFor="my-runtime-model" className="flex items-center gap-2 text-sm font-medium">
                      <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      {copy.preference.model}
                    </label>
                    <select
                      id="my-runtime-model"
                      className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                      value={draft?.modelId ?? ''}
                      onChange={(event) => handleModelChange(event.target.value)}
                      disabled={controlsDisabled || !selectedProvider || !canPrepareProvider(selectedProvider)}
                    >
                      <option value="" disabled>{copy.preference.selectModel}</option>
                      {draft && selectedProvider && !selectedModel && (
                        <option value={draft.modelId} disabled>{copy.preference.unavailable} · {draft.modelId}</option>
                      )}
                      {(selectedProvider?.models ?? []).map((model) => (
                        <option key={model.id} value={model.id} disabled={!model.enabled}>
                          {model.name || model.id}
                        </option>
                      ))}
                    </select>
                    {selectedModel && (
                      <p className="break-all font-mono text-[11px] leading-5 text-muted-foreground">
                        {selectedModel.id}
                      </p>
                    )}
                  </div>
                </div>

                {selectedProvider && (
                  <div className="grid min-w-0 gap-3 rounded-lg border bg-muted/15 p-3 sm:grid-cols-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.preference.installation}</p>
                      <p className="mt-1 break-all font-mono text-[11px]">{selectedProvider.installationId}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.preference.credentialScope}</p>
                      <p className="mt-1 text-sm font-medium">
                        {copy.credentialScope[selectedProvider.credentialScope] || selectedProvider.credentialScope}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.preference.readiness}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <Badge variant={selectedProvider.selectable ? 'secondary' : 'outline'}>
                          {copy.providerStatus[selectedProvider.status] || selectedProvider.status}
                        </Badge>
                        <Badge variant="outline" className="gap-1">
                          <KeyRound className="h-3 w-3" aria-hidden="true" />
                          {selectedProvider.credentialAvailable ? copy.preference.credentialAvailable : copy.preference.credentialMissing}
                        </Badge>
                      </div>
                    </div>
                  </div>
                )}

                {selectedProvider?.credentialScope === 'user' && (
                  <div className="min-w-0 space-y-4 rounded-lg border border-primary/20 bg-primary/[0.025] p-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background shadow-sm">
                        <KeyRound className="h-4 w-4 text-primary" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                          {copy.credentials.section}
                        </p>
                        <h3 className="mt-1 text-sm font-semibold">{copy.credentials.title}</h3>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.credentials.description}</p>
                      </div>
                    </div>

                    {!selectedProvider.credentialAvailable && (
                      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200" role="status">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{copy.credentials.missing}</span>
                      </div>
                    )}

                    <ProviderInstallationCredentialEditor
                      key={selectedProvider.installationId}
                      locale={locale}
                      showIdentity={false}
                      installation={{
                        installationId: selectedProvider.installationId,
                        providerId: selectedProvider.providerId,
                        name: selectedProvider.name,
                        credentialScope: selectedProvider.credentialScope,
                        authMethod: selectedProvider.authMethod,
                      }}
                      onCredentialsSaved={handleCredentialsSaved}
                    />
                  </div>
                )}

                <fieldset
                  className="min-w-0 space-y-3"
                  disabled={controlsDisabled || !selectedModel}
                  aria-describedby="my-runtime-intelligence-help"
                >
                  <legend className="flex items-center gap-2 text-sm font-medium">
                    <CircleGauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    {copy.preference.intelligence}
                  </legend>
                  <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
                    {(selectedModel?.thinkingLevels ?? []).map((level) => {
                      const selected = draft?.thinkingLevel === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          className={cn(
                            'min-h-10 rounded-md border px-3 py-2 text-sm font-medium outline-none transition',
                            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            selected
                              ? 'border-primary bg-primary/8 text-primary shadow-sm'
                              : 'bg-background hover:border-primary/50 hover:bg-muted/40',
                          )}
                          aria-pressed={selected}
                          onClick={() => {
                            if (!draft) return;
                            setDraft({ ...draft, thinkingLevel: level });
                            setNotice(null);
                          }}
                        >
                          {copy.intelligenceLevel[level] || level}
                        </button>
                      );
                    })}
                  </div>
                  <p id="my-runtime-intelligence-help" className="text-xs leading-5 text-muted-foreground">
                    {copy.preference.intelligenceHelp}
                  </p>
                </fieldset>

                {notice && (
                  <div
                    role={notice.tone === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className={cn(
                      'flex items-start gap-2 rounded-md border p-3 text-sm',
                      notice.tone === 'success'
                        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
                        : 'border-destructive/30 bg-destructive/5 text-destructive',
                    )}
                  >
                    {notice.tone === 'success'
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                    <span className="break-words">{notice.message}</span>
                  </div>
                )}

                <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void handleReset()}
                    disabled={controlsDisabled || !resolution.preference}
                    className="w-full sm:w-auto"
                  >
                    {mutation === 'reset' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    {copy.preference.useInherited}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={controlsDisabled || !draftIsSelectable || !draftIsDirty}
                    className="w-full sm:w-auto"
                  >
                    {mutation === 'save' ? <Loader2 className="animate-spin" /> : <Save />}
                    {copy.preference.save}
                  </Button>
                </div>
              </div>

              <aside className="min-w-0 space-y-3" aria-label={copy.summary.aria}>
                <SelectionSummary
                  title={copy.summary.effectiveTitle}
                  description={copy.summary.effectiveDescription}
                  resolution={resolution}
                  selection={resolution.effectiveSelection?.selection}
                  source={resolution.source}
                  copy={copy}
                />
                <SelectionSummary
                  title={copy.summary.inheritedTitle}
                  description={copy.summary.inheritedDescription}
                  resolution={resolution}
                  selection={resolution.inheritedSelection?.selection}
                  source={resolution.inheritedSelection?.selectionSource ?? null}
                  subdued
                  copy={copy}
                />
                <div className="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">
                  <div className="mb-2 flex items-center gap-2 font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                    {copy.summary.policyTitle}
                  </div>
                  {copy.summary.policyDescription}
                </div>
              </aside>
            </div>
          </CardContent>
        </Card>
      )}

      {!sourcesLoading && !sourcesError && (!selectedWorkspaceId || !selectedAgentId) && (
        <Card className="border-dashed">
          <CardContent className="flex min-h-36 flex-col items-center justify-center gap-3 px-4 text-center sm:px-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Layers3 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold">{copy.empty.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {copy.empty.description}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export default MyAgentRuntimePanel;
