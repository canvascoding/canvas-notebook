import type { WorkspaceNativeCopyDependencies } from '../../app/lib/collaboration/workspace-native-copy';

/** Explicit physical-only fixture boundary; PostgreSQL tests exercise native inventory and publication. */
export const emptyNativeCopyDependencies: WorkspaceNativeCopyDependencies = {
  inspect: async () => ({ hasNativeSource: false, sourceIsDirectory: false,
    targetDocumentPaths: [], initializedTargetPaths: [], resumeTargetPath: null }),
  publish: async () => { throw new Error('Native copy publication is outside this physical-only fixture.'); },
};
