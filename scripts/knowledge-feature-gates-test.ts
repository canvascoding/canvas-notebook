import assert from 'node:assert/strict';

import {
  collectEnabledKnowledgeFeatureGateBlockers,
  getKnowledgeFeatureGate,
  resolveKnowledgeFeatureGates,
} from '../app/lib/knowledge/feature-gates';
import type {
  KnowledgeParsingSettings,
  KnowledgeResourceStatus,
} from '../app/lib/knowledge/settings-types';
import type { OrganizationPermissionState } from '../app/lib/organization/bootstrap';

const BASE_SETTINGS: KnowledgeParsingSettings = {
  knowledgeAutoIngestionEnabled: false,
  heavyDocumentParsingEnabled: false,
  doclingEnabled: false,
  ocrEnabled: false,
  embeddingIndexingEnabled: false,
  ragRetrievalEnabled: false,
  knowledgeGraphEnabled: false,
  liveCollaborationEnabled: false,
  remoteParsingEnabled: false,
  maxConcurrentHeavyJobs: 1,
  maxDocumentSizeMb: 25,
  maxPages: 200,
  maxOcrPages: 25,
  perFileTimeoutSeconds: 120,
  minimumFreeMemoryMb: 512,
  updatedAt: null,
  updatedByUserId: null,
};

const TEAM_STATE: OrganizationPermissionState = {
  configured: true,
  organizationId: 'org-gates',
  ownerUserId: 'owner-user',
  teamFeaturesEnabled: true,
  databaseProvider: 'postgres',
  permission: null,
};

function resourceStatus(overrides: Partial<KnowledgeResourceStatus>): KnowledgeResourceStatus {
  return {
    availability: 'available',
    resourceProfile: 'standard',
    databaseProvider: 'postgres',
    postgresRequired: true,
    postgresReady: true,
    pgvectorReady: true,
    memory: {
      totalMb: 4096,
      freeMb: 2048,
      thresholdMb: 2048,
    },
    cpu: {
      count: 2,
    },
    disk: {
      freeGb: 50,
      thresholdGb: 10,
    },
    queue: {
      depth: 0,
      activeHeavyJobs: 0,
    },
    parser: {
      docling: 'disabled',
      ocr: 'disabled',
      embeddings: 'available',
      remoteParsing: 'disabled',
    },
    canEnableKnowledge: true,
    blockers: [],
    warnings: [],
    checkedAt: new Date(0).toISOString(),
    featureGates: [],
    ...overrides,
  };
}

function main() {
  const sqliteStatus = resourceStatus({
    availability: 'disabled',
    databaseProvider: 'sqlite',
    postgresReady: false,
    pgvectorReady: false,
    canEnableKnowledge: false,
    blockers: ['requires_postgres'],
  });
  const sqliteGates = resolveKnowledgeFeatureGates({
    settings: BASE_SETTINGS,
    resourceStatus: sqliteStatus,
    state: TEAM_STATE,
  });
  assert.equal(getKnowledgeFeatureGate(sqliteGates, 'knowledge_auto_ingestion')?.status, 'blocked');
  assert.equal(getKnowledgeFeatureGate(sqliteGates, 'rag_retrieval')?.blockers.includes('requires_postgres'), true);

  const allRequestedOnSqlite = resolveKnowledgeFeatureGates({
    settings: {
      ...BASE_SETTINGS,
      knowledgeAutoIngestionEnabled: true,
      embeddingIndexingEnabled: true,
      ragRetrievalEnabled: true,
      knowledgeGraphEnabled: true,
      liveCollaborationEnabled: true,
    },
    resourceStatus: sqliteStatus,
    state: TEAM_STATE,
  });
  const sqliteBlockers = collectEnabledKnowledgeFeatureGateBlockers(allRequestedOnSqlite);
  assert.ok(sqliteBlockers.includes('requires_postgres'));
  assert.ok(sqliteBlockers.includes('requires_pgvector'));

  const postgresWithoutPgvector = resourceStatus({
    pgvectorReady: false,
    blockers: ['requires_pgvector'],
  });
  const postgresNoVectorGates = resolveKnowledgeFeatureGates({
    settings: {
      ...BASE_SETTINGS,
      knowledgeAutoIngestionEnabled: true,
      knowledgeGraphEnabled: true,
      liveCollaborationEnabled: true,
    },
    resourceStatus: postgresWithoutPgvector,
    state: TEAM_STATE,
  });
  assert.ok(getKnowledgeFeatureGate(postgresNoVectorGates, 'embedding_indexing')?.blockers.includes('requires_pgvector'));
  assert.equal(getKnowledgeFeatureGate(postgresNoVectorGates, 'knowledge_graph')?.status, 'enabled');
  assert.equal(getKnowledgeFeatureGate(postgresNoVectorGates, 'live_collaboration')?.status, 'enabled');

  const readyGates = resolveKnowledgeFeatureGates({
    settings: {
      ...BASE_SETTINGS,
      knowledgeAutoIngestionEnabled: true,
      embeddingIndexingEnabled: true,
      ragRetrievalEnabled: true,
      knowledgeGraphEnabled: true,
      liveCollaborationEnabled: true,
    },
    resourceStatus: resourceStatus({}),
    state: TEAM_STATE,
  });
  assert.deepEqual(collectEnabledKnowledgeFeatureGateBlockers(readyGates), []);
  assert.equal(getKnowledgeFeatureGate(readyGates, 'rag_retrieval')?.status, 'enabled');

  const missingDependencyGates = resolveKnowledgeFeatureGates({
    settings: {
      ...BASE_SETTINGS,
      ragRetrievalEnabled: true,
    },
    resourceStatus: resourceStatus({}),
    state: TEAM_STATE,
  });
  assert.ok(getKnowledgeFeatureGate(missingDependencyGates, 'rag_retrieval')?.blockers.includes('requires_embedding_indexing'));

  const noTeamGates = resolveKnowledgeFeatureGates({
    settings: {
      ...BASE_SETTINGS,
      liveCollaborationEnabled: true,
    },
    resourceStatus: resourceStatus({}),
    state: {
      ...TEAM_STATE,
      teamFeaturesEnabled: false,
    },
  });
  assert.ok(getKnowledgeFeatureGate(noTeamGates, 'live_collaboration')?.blockers.includes('requires_team_features'));

  console.log('knowledge-feature-gates-test: ok');
}

main();
