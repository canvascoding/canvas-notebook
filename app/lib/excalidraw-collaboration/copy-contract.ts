import 'server-only';

import type { WorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';
import type { WorkspaceOperationJobScope } from '../files/workspace-operation-batch-contract';
import type { ExcalidrawAssetMetadata } from './protocol';

export type ExcalidrawCopyFileIdentity = Readonly<{
  dev: string; ino: string; uid: number; mode: number; sizeBytes: number;
}>;
export type ExcalidrawCopyDirectoryIdentity = Readonly<{ dev: string; ino: string; uid: number; mode: number }>;
/** Immutable file attribution without the manifest's self-referential size/hash. */
export type ExcalidrawCopyManifestIdentity = Readonly<{ dev: string; ino: string; uid: number; mode: 0o600 }>;
export type ExcalidrawCopyAssetBlobOriginal = Readonly<{
  contentHash: string; sizeBytes: number; storageKey: string;
  disposition: 'reuse' | 'birth'; identity: ExcalidrawCopyFileIdentity;
}>;
/** Private mechanical observations. This data is never a publication grant. */
export type ExcalidrawCopyAssetOriginal = Readonly<{
  version: 1; operationId: string; stageDigest: string; destinationScope: WorkspaceOperationJobScope;
  configuredDataRoot: string; resolvedDataRoot: string;
  ancestors: readonly Readonly<{ name: string; identity: ExcalidrawCopyDirectoryIdentity }>[];
  privateDirectory: Readonly<{ name: string; identity: ExcalidrawCopyDirectoryIdentity }>;
  manifestIdentity: ExcalidrawCopyManifestIdentity;
  metadata: readonly Readonly<ExcalidrawAssetMetadata>[];
  blobs: readonly ExcalidrawCopyAssetBlobOriginal[]; originalProof: string;
}>;
export type ExcalidrawCopyAssetReceipt = Readonly<{
  version: 1; operationId: string; stageDigest: string; originalProof: string;
  blobs: readonly Readonly<{ contentHash: string; sizeBytes: number; storageKey: string;
    disposition: 'reuse' | 'birth'; identity: ExcalidrawCopyFileIdentity }>[];
  receiptProof: string;
}>;
export type ExcalidrawCopyDocumentIntent = Readonly<{
  sourceWorkspaceId: string; sourcePath: string; sourceDocumentId: string; sourceLineageId: string;
  sourceGeneration: number; sourceSceneSequence: number; sourceCanonicalHash: string; sourceContentProof: string;
  destinationWorkspaceId: string; destinationPath: string; documentId: string; lineageId: string;
}>;
export type ExcalidrawCopyIntent = Readonly<{
  version: 1; operationId: string; stageDigest: string; requestHash: string; origin: WorkspaceOperationCopyOrigin;
  nativeRequestFingerprint: string; nativeReceiptProof: string; b1TransactionId: string; createdAt: number;
  assetOriginal: ExcalidrawCopyAssetOriginal; documents: readonly ExcalidrawCopyDocumentIntent[]; intentDigest: string;
}>;
/** SQL disposition only. The owner must still receive its actual B2 COMMIT ACK. */
export type ExcalidrawCopyBirthReceipt = Readonly<{
  version: 1; operationId: string; stageDigest: string; intent: ExcalidrawCopyIntent;
  documents: readonly Readonly<{ documentId: string; lineageId: string; workspaceId: string; path: string;
    lifecycleGeneration: 1; sceneSequence: 0; canonicalHash: string; persistedAt: number }>[];
  assetReceipt: ExcalidrawCopyAssetReceipt; pathReceiptProofs: readonly string[];
  b2TransactionId: string; receiptProof: string;
}>;
export type ExcalidrawCopyReceiptStorageIdentity = Readonly<{
  schemaName: string; schemaOid: number; databaseOid: number; tableOid: number; functionOid: number; triggerOid: number;
}>;
export class ExcalidrawCopyError extends Error {
  readonly status: number;
  constructor(readonly code: 'EXCALIDRAW_COPY_INVALID' | 'EXCALIDRAW_COPY_CHANGED' | 'EXCALIDRAW_COPY_TOO_LARGE'
    | 'EXCALIDRAW_COPY_ASSET_CONFLICT' | 'EXCALIDRAW_COPY_PUBLICATION_UNCONFIRMED'
    | 'EXCALIDRAW_COPY_STORAGE_CHANGED' | 'EXCALIDRAW_COPY_TRANSACTION_CHANGED') {
    super(code); this.name = 'ExcalidrawCopyError'; this.status = code === 'EXCALIDRAW_COPY_TOO_LARGE' ? 413 : 409;
  }
}
