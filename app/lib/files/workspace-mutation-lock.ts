import 'server-only';

// Shared kernel-lock implementation also serves the ENV secret store.
export { WorkspaceMutationLockError, acquireKernelLock, withWorkspaceMutationLock } from '../secrets/file-mutation-lock';
