import 'server-only';

import type { OrganizationPermissionState } from '@/app/lib/organization/bootstrap';
import type {
  KnowledgeFeatureGate,
  KnowledgeFeatureGateKey,
  KnowledgeParsingSettings,
  KnowledgeResourceStatus,
} from '@/app/lib/knowledge/settings-types';

type GateResourceStatus = Pick<
  KnowledgeResourceStatus,
  'postgresReady' | 'pgvectorReady' | 'resourceProfile' | 'blockers' | 'warnings'
>;

type FeatureGateSpec = {
  key: KnowledgeFeatureGateKey;
  enabled: (settings: KnowledgeParsingSettings) => boolean;
  requiresPostgres: boolean;
  requiresPgvector: boolean;
  requiresHeavyResourcePreflight: boolean;
  dependencyBlockers: (settings: KnowledgeParsingSettings, state?: OrganizationPermissionState | null) => string[];
  requirements: string[];
};

const HEAVY_RESOURCE_BLOCKERS = new Set([
  'memory_below_2gb',
  'disk_below_10gb',
]);

const FEATURE_GATE_SPECS: FeatureGateSpec[] = [
  {
    key: 'knowledge_auto_ingestion',
    enabled: (settings) => settings.knowledgeAutoIngestionEnabled,
    requiresPostgres: true,
    requiresPgvector: true,
    requiresHeavyResourcePreflight: true,
    dependencyBlockers: () => [],
    requirements: ['scope_policy', 'secret_pii_scan', 'source_acl_filter'],
  },
  {
    key: 'embedding_indexing',
    enabled: (settings) => settings.embeddingIndexingEnabled,
    requiresPostgres: true,
    requiresPgvector: true,
    requiresHeavyResourcePreflight: true,
    dependencyBlockers: (settings) => settings.knowledgeAutoIngestionEnabled ? [] : ['requires_knowledge_auto_ingestion'],
    requirements: ['scan_clean_or_redacted', 'source_acl_filter', 'pgvector_index'],
  },
  {
    key: 'rag_retrieval',
    enabled: (settings) => settings.ragRetrievalEnabled,
    requiresPostgres: true,
    requiresPgvector: true,
    requiresHeavyResourcePreflight: false,
    dependencyBlockers: (settings) => {
      const blockers: string[] = [];
      if (!settings.knowledgeAutoIngestionEnabled) blockers.push('requires_knowledge_auto_ingestion');
      if (!settings.embeddingIndexingEnabled) blockers.push('requires_embedding_indexing');
      return blockers;
    },
    requirements: ['retrieval_scope_filter', 'source_acl_recheck', 'source_citation'],
  },
  {
    key: 'knowledge_graph',
    enabled: (settings) => settings.knowledgeGraphEnabled,
    requiresPostgres: true,
    requiresPgvector: false,
    requiresHeavyResourcePreflight: true,
    dependencyBlockers: (settings) => settings.knowledgeAutoIngestionEnabled ? [] : ['requires_knowledge_auto_ingestion'],
    requirements: ['source_acl_filter', 'graph_source_references', 'delete_revocation'],
  },
  {
    key: 'live_collaboration',
    enabled: (settings) => settings.liveCollaborationEnabled,
    requiresPostgres: true,
    requiresPgvector: false,
    requiresHeavyResourcePreflight: false,
    dependencyBlockers: (_settings, state) => state?.teamFeaturesEnabled === true ? [] : ['requires_team_features'],
    requirements: ['revision_check', 'presence_state', 'agent_write_guard'],
  },
];

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function featureStatus(enabled: boolean, blockers: string[]): KnowledgeFeatureGate['status'] {
  if (blockers.length > 0) return 'blocked';
  return enabled ? 'enabled' : 'available';
}

function providerBlockers(spec: FeatureGateSpec, resourceStatus: GateResourceStatus): string[] {
  const blockers: string[] = [];
  if (spec.requiresPostgres && !resourceStatus.postgresReady) blockers.push('requires_postgres');
  if (spec.requiresPgvector && !resourceStatus.pgvectorReady) blockers.push('requires_pgvector');
  if (spec.requiresHeavyResourcePreflight) {
    blockers.push(...resourceStatus.blockers.filter((blocker) => HEAVY_RESOURCE_BLOCKERS.has(blocker)));
    if (resourceStatus.resourceProfile === 'disabled') blockers.push('resource_profile_disabled');
  }
  return blockers;
}

export function resolveKnowledgeFeatureGates(input: {
  settings: KnowledgeParsingSettings;
  resourceStatus: GateResourceStatus;
  state?: OrganizationPermissionState | null;
}): KnowledgeFeatureGate[] {
  return FEATURE_GATE_SPECS.map((spec) => {
    const enabled = spec.enabled(input.settings);
    const blockers = unique([
      ...providerBlockers(spec, input.resourceStatus),
      ...spec.dependencyBlockers(input.settings, input.state),
    ]);

    return {
      key: spec.key,
      enabled,
      available: blockers.length === 0,
      status: featureStatus(enabled, blockers),
      requiresPostgres: spec.requiresPostgres,
      requiresPgvector: spec.requiresPgvector,
      blockers,
      warnings: unique(input.resourceStatus.warnings),
      requirements: spec.requirements,
    };
  });
}

export function collectEnabledKnowledgeFeatureGateBlockers(gates: KnowledgeFeatureGate[]): string[] {
  return unique(gates.flatMap((gate) => gate.enabled ? gate.blockers : []));
}

export function getKnowledgeFeatureGate(
  gates: KnowledgeFeatureGate[],
  key: KnowledgeFeatureGateKey,
): KnowledgeFeatureGate | null {
  return gates.find((gate) => gate.key === key) ?? null;
}
