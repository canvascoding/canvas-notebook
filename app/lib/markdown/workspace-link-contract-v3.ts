import type { NativeDocumentLink, NativeDocumentLinkInventory, NativeNamespaceEntry, NativeResolvedLink,
  NativeWorkspaceFileOperationPlan } from './workspace-link-contract-v2';
import type { OriginalPhysicalLinkInventory } from './workspace-physical-link-inventory';

/** Exact original-source evidence without its private byte payload. This is
 * read authority only; its spans are never NativeLinkReference values. */
export type PhysicalReadLinkInventory = Omit<OriginalPhysicalLinkInventory, 'originalBytes'>;

export type WorkspaceMixedReadLinkSnapshotV3 = {
  contractVersion: 3;
  workspaceId: string;
  /** Full visible namespace, including physical files and implied directories. */
  namespace: NativeNamespaceEntry[];
  documents: NativeDocumentLinkInventory[];
  physicalSources: PhysicalReadLinkInventory[];
  coverage: { complete: boolean; gaps: Array<{ code: string; path: string }> };
  snapshotProof: string;
};

export type MixedReadResolvedLinkV3 =
  | (NativeResolvedLink & { sourceKind: 'native' })
  | (Pick<NativeDocumentLink, 'id' | 'kind' | 'syntax' | 'literal' | 'targetPathText' | 'fragment' | 'alias' | 'embed'> & {
      sourceKind: 'physical-read';
      classification: 'local';
      source: { workspaceId: string; organizationId: string | null; path: string;
        physicalSourceIdentity: PhysicalReadLinkInventory['physical'] };
      physicalSourceProof: string;
      resolution: NativeResolvedLink['resolution'];
    });

export type WorkspaceMixedReadLinkGraphV3 = Omit<WorkspaceMixedReadLinkSnapshotV3, 'snapshotProof'> & {
  snapshotProof: string;
  edges: MixedReadResolvedLinkV3[];
};

export type FilePlanV3 = Omit<NativeWorkspaceFileOperationPlan, 'contractVersion'> & { contractVersion: 3 };
