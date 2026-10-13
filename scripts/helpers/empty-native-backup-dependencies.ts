import type { WorkspaceOperationBackupDependencies } from '../../app/lib/files/workspace-operation-backup';

/** Physical-only unit fixture, explicitly proving an empty durable catalogue instead of hiding unavailable storage. */
export const emptyNativeBackupDependencies: WorkspaceOperationBackupDependencies = {
  captureNative: async () => [], readTargetCatalogue: async () => [],
  withLifecycleGuard: async (_input, work) => work(),
  persistCopies: async () => { throw new Error('This physical-only fixture must not create native document state.'); },
  completePublication: async () => { throw new Error('This physical-only fixture has no native publication receipt.'); },
};
