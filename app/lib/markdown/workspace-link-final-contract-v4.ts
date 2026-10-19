import type { MixedReadResolvedLinkV3, WorkspaceMixedReadLinkSnapshotV3 } from './workspace-link-contract-v3';
import type { NativeDocumentLinkInventory } from './workspace-link-contract-v2';
import type { NativeDocumentLinkInventoryV3 } from './workspace-native-link-inventory';

/** Final observation only. Original source snapshots/evidence remain version 3
 * with parser 2. A parser-3 target requires the complete genuine RawBirth cohort
 * checked by assertNativeCopyFinalRawImportGraphV4, not an arbitrary ID allowlist. */
export type WorkspaceMixedImportFinalLinkSnapshotV4 = Omit<WorkspaceMixedReadLinkSnapshotV3,
  'contractVersion' | 'documents'> & {
  contractVersion: 4;
  documents: Array<NativeDocumentLinkInventory | NativeDocumentLinkInventoryV3>;
};
export type WorkspaceMixedImportFinalLinkGraphV4 = WorkspaceMixedImportFinalLinkSnapshotV4 & {
  edges: MixedReadResolvedLinkV3[];
};
