export type KnowledgeResourceProfile = 'disabled' | 'low' | 'standard' | 'large';
export type KnowledgeResourceAvailability = 'available' | 'degraded' | 'disabled';

export interface KnowledgeParsingSettings {
  knowledgeAutoIngestionEnabled: boolean;
  heavyDocumentParsingEnabled: boolean;
  doclingEnabled: boolean;
  ocrEnabled: boolean;
  embeddingIndexingEnabled: boolean;
  remoteParsingEnabled: boolean;
  maxConcurrentHeavyJobs: number;
  maxDocumentSizeMb: number;
  maxPages: number;
  maxOcrPages: number;
  perFileTimeoutSeconds: number;
  minimumFreeMemoryMb: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export interface KnowledgeResourceStatus {
  availability: KnowledgeResourceAvailability;
  resourceProfile: KnowledgeResourceProfile;
  databaseProvider: string;
  postgresRequired: boolean;
  postgresReady: boolean;
  pgvectorReady: boolean;
  memory: {
    totalMb: number | null;
    freeMb: number | null;
    thresholdMb: number;
  };
  cpu: {
    count: number | null;
  };
  disk: {
    freeGb: number | null;
    thresholdGb: number;
  };
  queue: {
    depth: number;
    activeHeavyJobs: number;
  };
  parser: {
    docling: 'available' | 'disabled' | 'missing';
    ocr: 'available' | 'disabled' | 'missing';
    embeddings: 'available' | 'disabled' | 'requires_postgres';
    remoteParsing: 'disabled' | 'enabled';
  };
  canEnableKnowledge: boolean;
  blockers: string[];
  warnings: string[];
  checkedAt: string;
}

export interface KnowledgeOperationalLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  actorUserId: string | null;
  organizationId: string | null;
  reasonCode: string;
  changedKeys: string[];
  changes: Record<string, { from: boolean | number | string | null; to: boolean | number | string | null }>;
  resourceProfile: KnowledgeResourceProfile;
  blockers: string[];
  message: string;
}

export interface KnowledgeSettingsResponse {
  settings: KnowledgeParsingSettings;
  resourceStatus: KnowledgeResourceStatus;
  logs: KnowledgeOperationalLogEntry[];
  storage: {
    scope: 'organization' | 'system';
  };
  permission: {
    canUpdate: boolean;
  };
}
