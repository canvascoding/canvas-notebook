/** Historical target evidence from GET /api/files/info, never an access grant.
 * Native annotations are independent of changing content sequences. */
export type WorkspaceFileMetadataTarget = Readonly<{
  version: 1;
  workspaceId: string;
  path: string;
} & (
  | { kind: 'native_file'; documentId: string; lifecycleGeneration: number }
  | { kind: 'filesystem'; fileVersion: string; entryType: 'file' | 'directory' }
)>;
