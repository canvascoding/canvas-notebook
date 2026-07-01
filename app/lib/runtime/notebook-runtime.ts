export type NotebookRuntimeMode = 'personal' | 'team';
export type NotebookDatabaseProvider = 'sqlite' | 'postgres';
export type NotebookVectorProvider = 'none' | 'pgvector' | 'external';
export type NotebookDeploymentMode = 'community' | 'managed-single' | 'managed-team' | 'enterprise-onprem' | string;

export type NotebookRuntimeCapabilityKey =
  | 'multiUser'
  | 'teamWorkspace'
  | 'vectorSearch'
  | 'liveCollaboration';

export type NotebookRuntimeCapabilities = Record<NotebookRuntimeCapabilityKey, boolean>;

export type NotebookRuntimeCompatibilityCode =
  | 'team_requires_postgres'
  | 'multi_user_requires_postgres'
  | 'team_workspace_requires_postgres'
  | 'vector_search_requires_postgres'
  | 'vector_provider_required'
  | 'pgvector_requires_postgres'
  | 'pgvector_required'
  | 'live_collaboration_requires_postgres';

export interface NotebookRuntimeCompatibilityProblem {
  code: NotebookRuntimeCompatibilityCode;
  message: string;
}

export interface NotebookRuntimeProfile {
  runtimeMode: NotebookRuntimeMode;
  deploymentMode: NotebookDeploymentMode;
  databaseProvider: NotebookDatabaseProvider;
  vectorProvider: NotebookVectorProvider;
  postgresRequired: boolean;
  capabilities: NotebookRuntimeCapabilities;
  compatible: boolean;
  blockers: NotebookRuntimeCompatibilityProblem[];
}

export const personalRuntimeCapabilities: NotebookRuntimeCapabilities = {
  multiUser: false,
  teamWorkspace: false,
  vectorSearch: false,
  liveCollaboration: false,
};

export const teamRuntimeCapabilities: NotebookRuntimeCapabilities = {
  multiUser: true,
  teamWorkspace: true,
  vectorSearch: true,
  liveCollaboration: false,
};

function problem(
  code: NotebookRuntimeCompatibilityCode,
  message: string,
): NotebookRuntimeCompatibilityProblem {
  return { code, message };
}

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim().toLowerCase();
  return result || null;
}

export function normalizeRuntimeMode(value: unknown): NotebookRuntimeMode | null {
  if (value === 'personal' || value === 'team') return value;
  if (typeof value !== 'string') return null;
  const mode = normalized(value);
  if (mode === 'personal' || mode === 'managed-single' || mode === 'single') return 'personal';
  if (mode === 'team' || mode === 'managed-team' || mode === 'enterprise-onprem' || mode === 'enterprise') return 'team';
  return null;
}

export function normalizeVectorProvider(value: unknown): NotebookVectorProvider | null {
  if (value === 'none' || value === 'pgvector' || value === 'external') return value;
  if (typeof value !== 'string') return null;
  const provider = normalized(value);
  if (provider === 'none' || provider === 'pgvector' || provider === 'external') return provider;
  return null;
}

export function runtimeModeFromDeploymentMode(deploymentMode: NotebookDeploymentMode | null | undefined): NotebookRuntimeMode {
  const mode = normalized(deploymentMode);
  return mode === 'managed-team' || mode === 'enterprise-onprem' ? 'team' : 'personal';
}

function mergeCapabilities(
  fallback: NotebookRuntimeCapabilities,
  capabilities?: Partial<NotebookRuntimeCapabilities> | null,
): NotebookRuntimeCapabilities {
  return {
    multiUser: capabilities?.multiUser ?? fallback.multiUser,
    teamWorkspace: capabilities?.teamWorkspace ?? fallback.teamWorkspace,
    vectorSearch: capabilities?.vectorSearch ?? fallback.vectorSearch,
    liveCollaboration: capabilities?.liveCollaboration ?? fallback.liveCollaboration,
  };
}

export function capabilitiesFromFeatures(features: Record<string, unknown> | null | undefined): NotebookRuntimeCapabilities {
  return {
    multiUser: features?.multiUser === true,
    teamWorkspace: features?.teamWorkspace === true,
    vectorSearch: features?.vectorSearch === true || features?.teamKnowledgeBase === true,
    liveCollaboration: features?.liveCollaboration === true,
  };
}

export function runtimeModeFromCapabilities(
  capabilities: NotebookRuntimeCapabilities,
  provider?: NotebookDatabaseProvider | null,
  postgresRequired?: boolean,
): NotebookRuntimeMode {
  return capabilities.multiUser ||
    capabilities.teamWorkspace ||
    capabilities.vectorSearch ||
    capabilities.liveCollaboration ||
    provider === 'postgres' ||
    postgresRequired === true
    ? 'team'
    : 'personal';
}

export function validateRuntimeCompatibility(input: {
  runtimeMode: NotebookRuntimeMode;
  databaseProvider: NotebookDatabaseProvider;
  vectorProvider: NotebookVectorProvider;
  capabilities: NotebookRuntimeCapabilities;
  pgvectorEnabled?: boolean;
}): NotebookRuntimeCompatibilityProblem[] {
  const blockers: NotebookRuntimeCompatibilityProblem[] = [];

  if (input.runtimeMode === 'team' && input.databaseProvider !== 'postgres') {
    blockers.push(problem('team_requires_postgres', 'Team runtime currently requires Postgres.'));
  }
  if (input.capabilities.multiUser && input.databaseProvider !== 'postgres') {
    blockers.push(problem('multi_user_requires_postgres', 'Multi-user capability currently requires Postgres.'));
  }
  if (input.capabilities.teamWorkspace && input.databaseProvider !== 'postgres') {
    blockers.push(problem('team_workspace_requires_postgres', 'Team workspace capability currently requires Postgres.'));
  }
  if (input.capabilities.vectorSearch && input.databaseProvider !== 'postgres') {
    blockers.push(problem('vector_search_requires_postgres', 'Vector search capability currently requires Postgres.'));
  }
  if (input.capabilities.vectorSearch && input.vectorProvider === 'none') {
    blockers.push(problem('vector_provider_required', 'Vector search capability requires a vector provider.'));
  }
  if (input.vectorProvider === 'pgvector' && input.databaseProvider !== 'postgres') {
    blockers.push(problem('pgvector_requires_postgres', 'pgvector requires Postgres.'));
  }
  if (input.capabilities.vectorSearch && input.vectorProvider === 'pgvector' && input.pgvectorEnabled === false) {
    blockers.push(problem('pgvector_required', 'This feature requires CANVAS_POSTGRES_VECTOR_ENABLED=true.'));
  }
  if (input.capabilities.liveCollaboration && input.databaseProvider !== 'postgres') {
    blockers.push(problem('live_collaboration_requires_postgres', 'Production live collaboration currently requires Postgres.'));
  }

  return blockers;
}

export function resolveNotebookRuntimeProfile(input: {
  runtimeMode?: NotebookRuntimeMode | string | null;
  deploymentMode?: NotebookDeploymentMode | null;
  databaseProvider?: NotebookDatabaseProvider | null;
  vectorProvider?: NotebookVectorProvider | string | null;
  postgresRequired?: boolean | null;
  capabilities?: Partial<NotebookRuntimeCapabilities> | null;
  pgvectorEnabled?: boolean;
} = {}): NotebookRuntimeProfile {
  const requestedRuntimeMode = normalizeRuntimeMode(input.runtimeMode);
  const deploymentRuntimeMode = input.deploymentMode ? runtimeModeFromDeploymentMode(input.deploymentMode) : null;
  const capabilityRuntimeMode = input.capabilities
    ? runtimeModeFromCapabilities(mergeCapabilities(personalRuntimeCapabilities, input.capabilities))
    : null;
  const defaultRuntimeMode = requestedRuntimeMode || deploymentRuntimeMode || capabilityRuntimeMode || 'personal';
  const fallbackCapabilities = defaultRuntimeMode === 'team' ? teamRuntimeCapabilities : personalRuntimeCapabilities;
  const capabilities = mergeCapabilities(fallbackCapabilities, input.capabilities);
  const runtimeMode = requestedRuntimeMode || runtimeModeFromCapabilities(capabilities, input.databaseProvider, input.postgresRequired ?? false);
  const databaseProvider = input.databaseProvider || (runtimeMode === 'team' ? 'postgres' : 'sqlite');
  const vectorProvider = normalizeVectorProvider(input.vectorProvider) || (capabilities.vectorSearch ? 'pgvector' : 'none');
  const postgresRequired = input.postgresRequired ?? (
    runtimeMode === 'team' ||
    capabilities.multiUser ||
    capabilities.teamWorkspace ||
    capabilities.vectorSearch ||
    capabilities.liveCollaboration
  );
  const blockers = validateRuntimeCompatibility({
    runtimeMode,
    databaseProvider,
    vectorProvider,
    capabilities,
    pgvectorEnabled: input.pgvectorEnabled,
  });

  return {
    runtimeMode,
    deploymentMode: input.deploymentMode || (runtimeMode === 'team' ? 'managed-team' : 'managed-single'),
    databaseProvider,
    vectorProvider,
    postgresRequired,
    capabilities,
    compatible: blockers.length === 0,
    blockers,
  };
}
