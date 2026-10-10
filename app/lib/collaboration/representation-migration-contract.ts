import { isCollaborationStateProof } from './state-proof';

export const MOBILE_RICH_MIGRATION_CAPABILITY = 'notebook.collaboration.rich_migration.v1' as const;
export const MOBILE_CHECKPOINT_CAPABILITY = 'notebook.collaboration.checkpoint.v1' as const;

/** The saved device state and the authoritative old checkpoint must agree. */
export type RichMigrationRequest = Readonly<{
  requestId: string;
  expectedDocumentId: string;
  expectedLifecycleGeneration: number;
  documentSequence: number;
  stateProof: string;
}>;

export type RichMigrationResult = Readonly<{
  requestId: string;
  status: 'migrated' | 'already_rich' | 'pending' | 'blocked' | 'unsupported';
  phase?: 'quiescence' | 'handoff' | 'projection';
  reason?: string;
  documentId: string;
  lifecycleGeneration: number;
}>;

export function parseRichMigrationRequest(value: unknown): RichMigrationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'documentSequence,expectedDocumentId,expectedLifecycleGeneration,requestId,stateProof'
    || typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.requestId)
    || typeof input.expectedDocumentId !== 'string' || !input.expectedDocumentId || input.expectedDocumentId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(input.expectedDocumentId)
    || !Number.isSafeInteger(input.expectedLifecycleGeneration) || Number(input.expectedLifecycleGeneration) < 1
    || !Number.isSafeInteger(input.documentSequence) || Number(input.documentSequence) < 0
    || !isCollaborationStateProof(input.stateProof)) return null;
  return Object.freeze({ requestId: input.requestId, expectedDocumentId: input.expectedDocumentId,
    expectedLifecycleGeneration: Number(input.expectedLifecycleGeneration), documentSequence: Number(input.documentSequence),
    stateProof: input.stateProof });
}
